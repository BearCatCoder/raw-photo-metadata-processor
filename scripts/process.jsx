#target photoshop

(function () {
    function fileExists(value) { return new File(value).exists; }
    function px(value) { return value.as("px"); }
    function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
    function gpsValue(decimal, positive, negative) {
        var absolute = Math.abs(Number(decimal));
        var degrees = Math.floor(absolute);
        var minutes = (absolute - degrees) * 60;
        return degrees + "," + minutes.toFixed(6) + (Number(decimal) >= 0 ? positive : negative);
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

        // Photoshop's caption field maps to IPTC Description. DocumentInfo
        // metadata is embedded in both subsequent PSD and JPEG saves.
        if (typeof RPP_CONFIG.description === "string" && RPP_CONFIG.description.length) {
            doc.info.caption = RPP_CONFIG.description;
        }
        if (RPP_CONFIG.keywords && RPP_CONFIG.keywords.length) {
            doc.info.keywords = RPP_CONFIG.keywords;
        }
        var creator = String(RPP_CONFIG.creator || doc.info.author || "").replace(/^\s+|\s+$/g, "");
        var copyrightNotice = String(doc.info.copyrightNotice || "").replace(/^\s+|\s+$/g, "");
        if (creator) {
            if (!copyrightNotice) {
                copyrightNotice = "Copyright (c) " + creator + ". All rights reserved.";
                doc.info.copyrightNotice = copyrightNotice;
            }
            doc.info.copyrighted = CopyrightedType.COPYRIGHTEDWORK;
        }
        if (RPP_CONFIG.gps || RPP_CONFIG.location || creator) {
            if (ExternalObject.AdobeXMPScript === undefined) {
                ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
            }
            var xmp = new XMPMeta(doc.xmpMetadata.rawData);
            if (RPP_CONFIG.gps) {
                var exifNamespace = "http://ns.adobe.com/exif/1.0/";
                xmp.setProperty(exifNamespace, "GPSLatitude", gpsValue(RPP_CONFIG.gps.latitude, "N", "S"));
                xmp.setProperty(exifNamespace, "GPSLongitude", gpsValue(RPP_CONFIG.gps.longitude, "E", "W"));
                xmp.setProperty(exifNamespace, "GPSMapDatum", "WGS-84");
            }
            if (RPP_CONFIG.location) {
                var photoshopNamespace = "http://ns.adobe.com/photoshop/1.0/";
                var iptcCoreNamespace = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";
                doc.info.city = RPP_CONFIG.location.city;
                doc.info.provinceState = RPP_CONFIG.location.stateProvince;
                doc.info.country = RPP_CONFIG.location.country;
                xmp.setProperty(photoshopNamespace, "City", RPP_CONFIG.location.city);
                xmp.setProperty(photoshopNamespace, "State", RPP_CONFIG.location.stateProvince);
                xmp.setProperty(photoshopNamespace, "Country", RPP_CONFIG.location.country);
                xmp.setProperty(iptcCoreNamespace, "CountryCode", RPP_CONFIG.location.isoCountryCode);
                if (RPP_CONFIG.location.sublocation) {
                    xmp.setProperty(iptcCoreNamespace, "Location", RPP_CONFIG.location.sublocation);
                }
            }
            if (creator) {
                var dcNamespace = "http://purl.org/dc/elements/1.1/";
                var rightsNamespace = "http://ns.adobe.com/xap/1.0/rights/";
                xmp.setLocalizedText(dcNamespace, "rights", "", "x-default", copyrightNotice);
                xmp.setProperty(rightsNamespace, "Marked", true, XMPConst.BOOLEAN);
                xmp.setLocalizedText(rightsNamespace, "UsageTerms", "", "x-default", "All rights reserved. The Creator retains all rights.");
            }
            doc.xmpMetadata.rawData = xmp.serialize();
        }

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
    } finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
        app.preferences.rulerUnits = originalUnits;
    }
}());
