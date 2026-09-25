#target photoshop

(function () {
    function fileExists(value) { return new File(value).exists; }
    function px(value) { return value.as("px"); }
    function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

    function applyPhotoshopFinish(doc, finish) {
        if (!finish) return;
        var exposure = clamp(Number(finish.exposure) || 0, -2, 2);
        var brightness = clamp(Number(finish.brightness) || 0, -50, 50);
        var contrast = clamp(Number(finish.contrast) || 0, -50, 50);
        var toneGamma = clamp(Number(finish.toneGamma) || 1, 0.5, 1.5);
        var cyanRed = clamp(Number(finish.cyanRed) || 0, -30, 30);
        var magentaGreen = clamp(Number(finish.magentaGreen) || 0, -30, 30);
        var yellowBlue = clamp(Number(finish.yellowBlue) || 0, -30, 30);

        if (Math.abs(exposure) > 0.001) {
            var exposureSettings = new ActionDescriptor();
            exposureSettings.putDouble(charIDToTypeID("Exps"), exposure);
            exposureSettings.putDouble(charIDToTypeID("Ofst"), 0);
            exposureSettings.putDouble(charIDToTypeID("Gmm "), 1);
            executeAction(charIDToTypeID("Exps"), exposureSettings, DialogModes.NO);
        }
        if (Math.abs(toneGamma - 1) > 0.001) {
            doc.activeLayer.adjustLevels(0, 255, toneGamma, 0, 255);
        }
        if (Math.abs(brightness) > 0.001 || Math.abs(contrast) > 0.001) {
            doc.activeLayer.adjustBrightnessContrast(brightness, contrast);
        }
        if (Math.abs(cyanRed) > 0.001 || Math.abs(magentaGreen) > 0.001 || Math.abs(yellowBlue) > 0.001) {
            doc.activeLayer.adjustColorBalance([0, 0, 0], [cyanRed, magentaGreen, yellowBlue], [0, 0, 0], true);
        }
    }

    if (!RPP_CONFIG.overwrite && (fileExists(RPP_CONFIG.psd) || fileExists(RPP_CONFIG.jpeg))) {
        throw new Error("An output file already exists and overwrite is disabled.");
    }

    var originalDialogs = app.displayDialogs;
    var originalUnits = app.preferences.rulerUnits;
    var doc = null;
    try {
        app.displayDialogs = DialogModes.NO;
        app.preferences.rulerUnits = Units.PIXELS;

        // Opening a RAW with dialogs disabled applies its temporary XMP settings and
        // creates a new Photoshop document—the scripted equivalent of Open as Copy.
        doc = app.open(new File(RPP_CONFIG.input));
        var sourceWidth = px(doc.width);
        var sourceHeight = px(doc.height);
        var angle = Number(RPP_CONFIG.straightenDegrees) || 0;
        if (Math.abs(angle) > 0.001) doc.rotateCanvas(angle);

        var width = px(doc.width);
        var height = px(doc.height);
        var orientation = RPP_CONFIG.orientation;
        if (orientation === "auto") orientation = width >= height ? "landscape" : "portrait";
        var ratio = orientation === "portrait" ? 2 / 3 : 3 / 2;

        var radians = Math.abs(angle) * Math.PI / 180;
        var cosine = Math.cos(radians);
        var sine = Math.sin(radians);
        var maxCropHeight = Math.min(
            sourceWidth / (ratio * cosine + sine),
            sourceHeight / (ratio * sine + cosine)
        );
        if (!isFinite(maxCropHeight) || maxCropHeight <= 0) {
            maxCropHeight = Math.min(height, width / ratio);
        }
        maxCropHeight = Math.min(maxCropHeight, height, width / ratio);
        var cropHeight = maxCropHeight * clamp(Number(RPP_CONFIG.cropScale) || 0.96, 0.5, 1);
        var cropWidth = cropHeight * ratio;
        // Force dimensions to an exact integer 3:2 pair so pixel rounding cannot
        // turn (for example) a 750x500 crop into 751x501.
        if (orientation === "portrait") {
            cropWidth = Math.max(2, Math.floor(cropWidth / 2) * 2);
            cropHeight = cropWidth * 3 / 2;
        } else {
            cropHeight = Math.max(2, Math.floor(cropHeight / 2) * 2);
            cropWidth = cropHeight * 3 / 2;
        }
        var centerX = clamp(Number(RPP_CONFIG.cropCenterX), 0, 1) * width;
        var centerY = clamp(Number(RPP_CONFIG.cropCenterY), 0, 1) * height;
        centerX = clamp(centerX, cropWidth / 2, width - cropWidth / 2);
        centerY = clamp(centerY, cropHeight / 2, height - cropHeight / 2);
        var left = Math.round(centerX - cropWidth / 2);
        var top = Math.round(centerY - cropHeight / 2);
        left = clamp(left, 0, width - cropWidth);
        top = clamp(top, 0, height - cropHeight);
        doc.crop([
            UnitValue(left, "px"),
            UnitValue(top, "px"),
            UnitValue(left + cropWidth, "px"),
            UnitValue(top + cropHeight, "px")
        ]);

        applyPhotoshopFinish(doc, RPP_CONFIG.photoshopFinish);

        var psdOptions = new PhotoshopSaveOptions();
        psdOptions.layers = true;
        psdOptions.embedColorProfile = true;
        doc.saveAs(new File(RPP_CONFIG.psd), psdOptions, true, Extension.LOWERCASE);

        doc.flatten();
        if (doc.mode !== DocumentMode.RGB) doc.changeMode(ChangeMode.RGB);
        if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) doc.bitsPerChannel = BitsPerChannelType.EIGHT;
        var jpegOptions = new JPEGSaveOptions();
        jpegOptions.quality = 12;
        jpegOptions.embedColorProfile = true;
        jpegOptions.formatOptions = FormatOptions.STANDARDBASELINE;
        doc.saveAs(new File(RPP_CONFIG.jpeg), jpegOptions, true, Extension.LOWERCASE);

        // Reopen the saved full-resolution JPEG in this same Photoshop bridge
        // call so identification uses the finished JPEG without another launch.
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = app.open(new File(RPP_CONFIG.jpeg));
        var previewWidth = px(doc.width);
        var previewHeight = px(doc.height);
        var previewLongest = Math.max(previewWidth, previewHeight);
        if (previewLongest > 1600) {
            var previewFactor = 1600 / previewLongest;
            doc.resizeImage(
                UnitValue(Math.round(previewWidth * previewFactor), "px"),
                UnitValue(Math.round(previewHeight * previewFactor), "px"),
                null,
                ResampleMethod.BICUBICSHARPER
            );
        }
        var previewOptions = new JPEGSaveOptions();
        previewOptions.quality = 10;
        previewOptions.embedColorProfile = true;
        previewOptions.formatOptions = FormatOptions.STANDARDBASELINE;
        doc.saveAs(new File(RPP_CONFIG.identificationPreview), previewOptions, true, Extension.LOWERCASE);
    } finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
        app.preferences.rulerUnits = originalUnits;
    }
}());
