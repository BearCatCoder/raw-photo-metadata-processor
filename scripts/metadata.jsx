#target photoshop

(function () {
    function parseCoordinate(value) {
        if (value === null || value === undefined) return null;
        var text = String(value).replace(/&quot;/g, '"').replace(/^\s+|\s+$/g, "");
        var directionMatch = text.match(/([NSEW])/i);
        var direction = directionMatch ? directionMatch[1].toUpperCase() : "";
        var parts = text.replace(/[NSEW]/ig, " ").replace(/,/g, " ").split(/\s+/);
        var values = [];
        for (var i = 0; i < parts.length; i += 1) {
            if (!parts[i]) continue;
            var rational = parts[i].match(/^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
            var parsed = rational ? Number(rational[1]) / Number(rational[2]) : Number(parts[i]);
            if (isFinite(parsed)) values.push(parsed);
        }
        if (!values.length) return null;
        var result = Math.abs(values[0]);
        if (values.length > 1) result += values[1] / 60;
        if (values.length > 2) result += values[2] / 3600;
        if (values[0] < 0 || direction === "S" || direction === "W") result = -result;
        return result;
    }

    function readCoordinate(doc, axis) {
        var raw = "";
        try { raw = doc.xmpMetadata.rawData || ""; } catch (_) {}
        var key = axis === "latitude" ? "GPSLatitude" : "GPSLongitude";
        var attribute = new RegExp("exif:" + key + "\\s*=\\s*\"([^\"]+)\"", "i");
        var element = new RegExp("<exif:" + key + "[^>]*>([^<]+)</exif:" + key + ">", "i");
        var match = raw.match(attribute) || raw.match(element);
        if (match) {
            var parsed = parseCoordinate(match[1]);
            if (parsed !== null && isFinite(parsed)) return parsed;
        }
        try {
            var exif = doc.info.exif;
            var wanted = axis === "latitude" ? "gps latitude" : "gps longitude";
            for (var i = 0; i < exif.length; i += 1) {
                var label = String(exif[i][0]).toLowerCase();
                if (label === wanted || (label.indexOf(wanted) >= 0 && label.indexOf("ref") < 0)) {
                    var fallback = parseCoordinate(exif[i][1]);
                    if (fallback !== null && isFinite(fallback)) return fallback;
                }
            }
        } catch (_) {}
        return null;
    }

    var originalDialogs = app.displayDialogs;
    var output = new File(RPP_CONFIG.output);
    output.encoding = "UTF-8";
    output.open("w");
    try {
        app.displayDialogs = DialogModes.NO;
        for (var index = 0; index < RPP_CONFIG.inputs.length; index += 1) {
            var doc = null;
            var latitude = null;
            var longitude = null;
            var description = "";
            var creator = "";
            try {
                doc = app.open(new File(RPP_CONFIG.inputs[index]));
                latitude = readCoordinate(doc, "latitude");
                longitude = readCoordinate(doc, "longitude");
                try { description = String(doc.info.caption || "").replace(/[\t\r\n]+/g, " "); } catch (_) {}
                try { creator = String(doc.info.author || "").replace(/[\t\r\n]+/g, " "); } catch (_) {}
            } finally {
                if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
            }
            output.writeln(index + "\t" + (latitude === null ? "" : String(latitude)) + "\t" + (longitude === null ? "" : String(longitude)) + "\t" + description + "\t" + creator);
        }
    } finally {
        output.close();
        app.displayDialogs = originalDialogs;
    }
}());
