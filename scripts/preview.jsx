#target photoshop

(function () {
    var originalDialogs = app.displayDialogs;
    var originalUnits = app.preferences.rulerUnits;
    var doc = null;
    try {
        app.displayDialogs = DialogModes.NO;
        app.preferences.rulerUnits = Units.PIXELS;
        var items = RPP_CONFIG.items || [{ input: RPP_CONFIG.input, output: RPP_CONFIG.output }];
        for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            doc = app.open(new File(items[itemIndex].input));
            doc.flatten();
            if (doc.mode !== DocumentMode.RGB) doc.changeMode(ChangeMode.RGB);
            if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) doc.bitsPerChannel = BitsPerChannelType.EIGHT;
            var width = doc.width.as("px");
            var height = doc.height.as("px");
            var longest = Math.max(width, height);
            if (longest > 1600) {
                var factor = 1600 / longest;
                doc.resizeImage(UnitValue(Math.round(width * factor), "px"), UnitValue(Math.round(height * factor), "px"), null, ResampleMethod.BICUBICSHARPER);
            }
            var output = new File(items[itemIndex].output);
            var options = new JPEGSaveOptions();
            options.quality = 10;
            options.embedColorProfile = true;
            options.formatOptions = FormatOptions.STANDARDBASELINE;
            doc.saveAs(output, options, true, Extension.LOWERCASE);
            doc.close(SaveOptions.DONOTSAVECHANGES);
            doc = null;
        }
    } finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
        app.preferences.rulerUnits = originalUnits;
    }
}());
