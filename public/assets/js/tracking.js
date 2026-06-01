// LogicPals Legacy Tracking Wrapper
// Canonical tracker is /assets/js/lp-tracking.js

(function () {
  'use strict';

  window.lpTrack = function (eventName, params = {}) {
    try {
      if (typeof window.LP_track === 'function') {
        window.LP_track(eventName, params);
      }

      if (typeof window.fbq === 'function') {
        window.fbq('trackCustom', eventName, params || {});
      }

      console.log('[LP Track]', eventName, params);
    } catch (err) {
      console.warn('[LP Track] failed:', eventName, err);
    }
  };
})();