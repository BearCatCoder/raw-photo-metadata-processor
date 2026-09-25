#target photoshop

(function () {
    function gpsValue(decimal, positive, negative) {
        var absolute = Math.abs(Number(decimal));
        var degrees = Math.floor(absolute);
        var minutes = (absolute - degrees) * 60;
        return degrees + "," + minutes.toFixed(6) + (Number(decimal) >= 0 ? positive : negative);
    }

    function applyMetadata(doc) {
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
    }

    var originalDialogs = app.displayDialogs;
    var doc = null;
    try {
        app.displayDialogs = DialogModes.NO;

        doc = app.open(new File(RPP_CONFIG.psd));
        applyMetadata(doc);
        var psdOptions = new PhotoshopSaveOptions();
        psdOptions.layers = true;
        psdOptions.embedColorProfile = true;
        doc.saveAs(new File(RPP_CONFIG.psd), psdOptions, true, Extension.LOWERCASE);
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = null;

        doc = app.open(new File(RPP_CONFIG.jpeg));
        applyMetadata(doc);
        var jpegOptions = new JPEGSaveOptions();
        jpegOptions.quality = 12;
        jpegOptions.embedColorProfile = true;
        jpegOptions.formatOptions = FormatOptions.STANDARDBASELINE;
        doc.saveAs(new File(RPP_CONFIG.jpeg), jpegOptions, true, Extension.LOWERCASE);
    } finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
    }
}());
