// LogicPals Enterprise Tracking Wrapper
// Canonical tracker is /assets/js/lp-tracking.js

(function () {
  'use strict';

  const GA4_ID = 'G-WXXFD6WR7O';

  window.dataLayer = window.dataLayer || [];

  // Load real GA4 gtag.js only once
  if (!document.querySelector('script[data-lp-ga4-direct="true"]')) {
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    s.setAttribute('data-lp-ga4-direct', 'true');
    document.head.appendChild(s);
  }

  window.gtag = window.gtag || function () {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());

  // Prevent duplicate page_view because GTM already handles page_view
  window.gtag('config', GA4_ID, {
    send_page_view: false
  });

  window.LP_track = function (eventName, params) {
    try {
      const cleanParams = params || {};

      // 1) GTM custom event
      window.dataLayer.push(Object.assign({ event: eventName }, cleanParams));

      // 2) Direct GA4 custom event
      window.gtag('event', eventName, cleanParams);

      console.log('[LP Track]', eventName, cleanParams);
    } catch (e) {
      console.warn('[LP_track] failed:', eventName, e);
    }
  };
})();