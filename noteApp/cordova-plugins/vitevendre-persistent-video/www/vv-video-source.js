'use strict';

var exec = require('cordova/exec');
var SERVICE = 'VvVideoSource';

// Petit pont Cordova : le plugin natif ne renvoie que des métadonnées ou une plage bornée.
module.exports = {
  pick: function (success, error) { exec(success, error, SERVICE, 'pick', []); },
  readRange: function (uri, start, length, success, error) {
    exec(success, error, SERVICE, 'readRange', [uri, start, length]);
  },
  loadPending: function (success, error) { exec(success, error, SERVICE, 'loadPending', []); },
  savePending: function (metadata, success, error) {
    exec(success, error, SERVICE, 'savePending', [metadata]);
  },
  finishUpload: function (videoId, success, error) {
    exec(success, error, SERVICE, 'finishUpload', [videoId]);
  },
  abandon: function (success, error) { exec(success, error, SERVICE, 'abandon', []); },
  releaseUri: function (uri, success, error) { exec(success, error, SERVICE, 'releaseUri', [uri]); },
};
