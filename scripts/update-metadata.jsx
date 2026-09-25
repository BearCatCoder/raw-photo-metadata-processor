#target photoshop

(function () {
    if (ExternalObject.AdobeXMPScript === undefined) {
        ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
    }

    var NS_DC = "http://purl.org/dc/elements/1.1/";
    var NS_EXIF = "http://ns.adobe.com/exif/1.0/";
    var NS_PHOTOSHOP = "http://ns.adobe.com/photoshop/1.0/";
    var NS_IPTC = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";
    var NS_RIGHTS = "http://ns.adobe.com/xap/1.0/rights/";

    function gpsValue(decimal, positive, negative) {
        var absolute = Math.abs(Number(decimal));
        var degrees = Math.floor(absolute);
        var minutes = (absolute - degrees) * 60;
        return degrees + "," + minutes.toFixed(6) + (Number(decimal) >= 0 ? positive : negative);
    }

    function propertyText(value) {
        return value === null || value === undefined ? "" : String(value).replace(/^\s+|\s+$/g, "");
    }

    function firstArrayItem(xmp, namespace, name) {
        try { return propertyText(xmp.getArrayItem(namespace, name, 1)); } catch (_) { return ""; }
    }

    function hasProperty(xmp, namespace, name) {
        try { return xmp.doesPropertyExist(namespace, name); } catch (_) { return false; }
    }

    function hasTextProperty(xmp, namespace, name) {
        try { return propertyText(xmp.getProperty(namespace, name)).length > 0; } catch (_) { return false; }
    }

    function hasLocalizedText(xmp, namespace, name) {
        try { return propertyText(xmp.getLocalizedText(namespace, name, "", "x-default")).length > 0; } catch (_) { return false; }
    }

    function appendMissingArrayItems(xmp, namespace, name, values) {
        var existing = {};
        var count = 0;
        try { count = xmp.countArrayItems(namespace, name); } catch (_) {}
        for (var existingIndex = 1; existingIndex <= count; existingIndex += 1) {
            var existingValue = firstArrayItemAt(xmp, namespace, name, existingIndex);
            if (existingValue) existing[existingValue.toLowerCase()] = true;
        }
        for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
            var value = propertyText(values[valueIndex]);
            if (value && !existing[value.toLowerCase()]) {
                xmp.appendArrayItem(namespace, name, value, 0, XMPConst.ARRAY_IS_UNORDERED);
                existing[value.toLowerCase()] = true;
            }
        }
    }

    function firstArrayItemAt(xmp, namespace, name, index) {
        try { return propertyText(xmp.getArrayItem(namespace, name, index)); } catch (_) { return ""; }
    }

    function applyMetadata(xmp, fillMissing) {
        if (typeof RPP_CONFIG.description === "string" && RPP_CONFIG.description.length && (!fillMissing || !hasLocalizedText(xmp, NS_DC, "description"))) {
            xmp.setLocalizedText(NS_DC, "description", "", "x-default", RPP_CONFIG.description);
        }
        if (RPP_CONFIG.keywords && RPP_CONFIG.keywords.length) {
            if (fillMissing) {
                appendMissingArrayItems(xmp, NS_DC, "subject", RPP_CONFIG.keywords);
            } else {
                xmp.deleteProperty(NS_DC, "subject");
                for (var keywordIndex = 0; keywordIndex < RPP_CONFIG.keywords.length; keywordIndex += 1) {
                    xmp.appendArrayItem(NS_DC, "subject", RPP_CONFIG.keywords[keywordIndex], 0, XMPConst.ARRAY_IS_UNORDERED);
                }
            }
        }
        if (RPP_CONFIG.gps) {
            if (!fillMissing || !hasTextProperty(xmp, NS_EXIF, "GPSLatitude")) xmp.setProperty(NS_EXIF, "GPSLatitude", gpsValue(RPP_CONFIG.gps.latitude, "N", "S"));
            if (!fillMissing || !hasTextProperty(xmp, NS_EXIF, "GPSLongitude")) xmp.setProperty(NS_EXIF, "GPSLongitude", gpsValue(RPP_CONFIG.gps.longitude, "E", "W"));
            if (!fillMissing || !hasTextProperty(xmp, NS_EXIF, "GPSMapDatum")) xmp.setProperty(NS_EXIF, "GPSMapDatum", "WGS-84");
        }
        if (RPP_CONFIG.location) {
            if (!fillMissing || !hasTextProperty(xmp, NS_PHOTOSHOP, "City")) xmp.setProperty(NS_PHOTOSHOP, "City", RPP_CONFIG.location.city);
            if (!fillMissing || !hasTextProperty(xmp, NS_PHOTOSHOP, "State")) xmp.setProperty(NS_PHOTOSHOP, "State", RPP_CONFIG.location.stateProvince);
            if (!fillMissing || !hasTextProperty(xmp, NS_PHOTOSHOP, "Country")) xmp.setProperty(NS_PHOTOSHOP, "Country", RPP_CONFIG.location.country);
            if (!fillMissing || !hasTextProperty(xmp, NS_IPTC, "CountryCode")) xmp.setProperty(NS_IPTC, "CountryCode", RPP_CONFIG.location.isoCountryCode);
            if (RPP_CONFIG.location.sublocation && (!fillMissing || !hasTextProperty(xmp, NS_IPTC, "Location"))) xmp.setProperty(NS_IPTC, "Location", RPP_CONFIG.location.sublocation);
        }
        if (RPP_CONFIG.iptcSceneCodes) {
            if (fillMissing) {
                appendMissingArrayItems(xmp, NS_IPTC, "Scene", RPP_CONFIG.iptcSceneCodes);
            } else {
                xmp.deleteProperty(NS_IPTC, "Scene");
                for (var sceneIndex = 0; sceneIndex < RPP_CONFIG.iptcSceneCodes.length; sceneIndex += 1) {
                    xmp.appendArrayItem(NS_IPTC, "Scene", RPP_CONFIG.iptcSceneCodes[sceneIndex], 0, XMPConst.ARRAY_IS_UNORDERED);
                }
            }
        }
        if (RPP_CONFIG.iptcSubjectCodes) {
            if (fillMissing) {
                appendMissingArrayItems(xmp, NS_IPTC, "SubjectCode", RPP_CONFIG.iptcSubjectCodes);
            } else {
                xmp.deleteProperty(NS_IPTC, "SubjectCode");
                for (var subjectIndex = 0; subjectIndex < RPP_CONFIG.iptcSubjectCodes.length; subjectIndex += 1) {
                    xmp.appendArrayItem(NS_IPTC, "SubjectCode", RPP_CONFIG.iptcSubjectCodes[subjectIndex], 0, XMPConst.ARRAY_IS_UNORDERED);
                }
            }
        }

        var creator = propertyText(RPP_CONFIG.creator) || firstArrayItem(xmp, NS_DC, "creator");
        if (creator) {
            var notice = "";
            try { notice = propertyText(xmp.getLocalizedText(NS_DC, "rights", "", "x-default")); } catch (_) {}
            if (!notice) {
                try { notice = propertyText(xmp.getProperty(NS_PHOTOSHOP, "Copyright")); } catch (_) {}
            }
            if (!notice) notice = "Copyright (c) " + creator + ". All rights reserved.";
            if (!fillMissing || !hasTextProperty(xmp, NS_PHOTOSHOP, "Copyright")) xmp.setProperty(NS_PHOTOSHOP, "Copyright", notice);
            if (!fillMissing || !hasLocalizedText(xmp, NS_DC, "rights")) xmp.setLocalizedText(NS_DC, "rights", "", "x-default", notice);
            if (!fillMissing || !hasProperty(xmp, NS_RIGHTS, "Marked")) xmp.setProperty(NS_RIGHTS, "Marked", true, XMPConst.BOOLEAN);
            if (!fillMissing || !hasLocalizedText(xmp, NS_RIGHTS, "UsageTerms")) xmp.setLocalizedText(NS_RIGHTS, "UsageTerms", "", "x-default", "All rights reserved. " + creator + " retains all rights.");
        }
    }

    function readSidecar(file) {
        if (!file.exists) return null;
        file.encoding = "UTF-8";
        if (!file.open("r")) return null;
        try { return file.read(); } finally { file.close(); }
    }

    function writeSidecar(file, xmp) {
        file.encoding = "UTF-8";
        file.lineFeed = "Unix";
        if (!file.open("w")) throw new Error("Could not write XMP sidecar: " + file.fsName);
        try { file.write(xmp.serialize()); } finally { file.close(); }
    }

    var result = new File(RPP_CONFIG.result);
    result.encoding = "UTF-8";
    result.open("w");
    try {
        for (var itemIndex = 0; itemIndex < RPP_CONFIG.items.length; itemIndex += 1) {
            var item = RPP_CONFIG.items[itemIndex];
            var source = new File(item.input);
            var sidecar = new File(item.sidecar);
            var extension = source.name.toLowerCase().replace(/^.*\./, "");
            var raw = /^(3fr|arw|cr2|cr3|dng|erf|iiq|kdc|mos|mrw|nef|nrw|orf|pef|raf|raw|rw2|rwl|srw|x3f)$/.test(extension);
            var fillMissing = raw && sidecar.exists;
            var xmpFile = null;
            var xmp = null;
            var direct = false;
            try {
                xmpFile = new XMPFile(source.fsName, XMPConst.UNKNOWN, XMPConst.OPEN_FOR_UPDATE);
                xmp = xmpFile.getXMP();
                if (!xmp) xmp = new XMPMeta();
                applyMetadata(xmp, fillMissing);
                if (xmpFile.canPutXMP(xmp)) {
                    xmpFile.putXMP(xmp);
                    xmpFile.closeFile(XMPConst.CLOSE_UPDATE_SAFELY);
                    xmpFile = null;
                    direct = true;
                }
            } catch (_) {
                if (xmpFile) {
                    try { xmpFile.closeFile(); } catch (__) {}
                    xmpFile = null;
                }
            }

            if (!direct && xmpFile) {
                try { xmpFile.closeFile(); } catch (_) {}
                xmpFile = null;
            }

            if (!direct) {
                if (!raw) throw new Error("Adobe XMP could not safely update metadata in place: " + source.fsName);
                var sidecarText = readSidecar(sidecar);
                if (sidecarText) {
                    try { xmp = new XMPMeta(sidecarText); } catch (_) {}
                }
                if (!xmp) xmp = new XMPMeta();
                applyMetadata(xmp, fillMissing);
                writeSidecar(sidecar, xmp);
            }
            var mode = (!direct || (raw && sidecar.exists)) ? "sidecar" : "embedded";
            result.writeln(source.fsName + "\t" + mode);
        }
    } finally {
        result.close();
    }
}());
