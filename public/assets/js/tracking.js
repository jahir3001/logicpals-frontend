// LogicPals Legacy Tracking Wrapper
// Canonical tracker is /assets/js/lp-tracking.js

(function () {
  'use strict';

  window.LP_track = function (eventName, params) {
  try {
    const payload = Object.assign({ event: eventName }, params || {});

    // 1) GTM dataLayer event
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);

    // 2) Direct GA4 event fallback
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, params || {});
    }

    console.log('[LP Track]', eventName, params || {});
  } catch (e) {
    console.warn('[LP_track] failed:', eventName, e);
  }
};
})();