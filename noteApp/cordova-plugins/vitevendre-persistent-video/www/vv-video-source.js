'use strict';

var exec = require('cordova/exec');
var SERVICE = 'VvVideoSource';

// Petit pont Cordova : le plugin natif ne renvoie que des métadonnées ou une plage bornée.
module.exports = {
  pick: function (success, error) { exec(success, error, SERVICE, 'pick', []); },
  readRange: function (uri, start, length, name, size, lastModified, location, success, error) {
    exec(success, error, SERVICE, 'readRange', [uri, start, length, name, size, lastModified, location]);
  },
  verify: function (uri, success, error) { exec(success, error, SERVICE, 'verify', [uri]); },
  fingerprint: function (uri, name, size, lastModified, location, success, error) {
    exec(success, error, SERVICE, 'fingerprint', [uri, name, size, lastModified, location]);
  },
  releaseUri: function (uri, success, error) { exec(success, error, SERVICE, 'releaseUri', [uri]); },
};
