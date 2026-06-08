/*
  LogicPals Brand Loader v2
  --------------------------------------------
  Purpose:
  - Applies the active LogicPals brand identity to any page that includes this file.
  - Supports admin-uploaded logo/favicon/site name/tagline.
  - Uses Supabase site_settings.brand when a Supabase client is available.
  - Uses localStorage only as a fast browser fallback, not as the source of truth.

  Required page wiring:
  - Add <script src="/assets/js/brand-loader.js" defer></script>
  - Add data-brand-logo to <img> tags that should receive the logo.
  - Add data-brand-name to text nodes that should receive the site name.
  - Add data-brand-tagline to text nodes that should receive the tagline/subtitle.
*/
(function () {
  'use strict';

  var STORAGE_KEY = 'logicpals_brand_settings';

  var DEFAULT_BRAND = {
    site_name: 'LogicPals',
    siteName: 'LogicPals',
    tagline: "THINK. DON'T MEMORIZE.",
    logo_url: 'https://ovszuxerimhbmzfblzkgd.supabase.co/storage/v1/object/public/blog-media/brand/logo-1780916136780.png',
    logoUrl: 'https://ovszuxerimhbmzfblzkgd.supabase.co/storage/v1/object/public/blog-media/brand/logo-1780916136780.png',
    favicon_url: '',
    faviconUrl: ''
  };

  function safeTrim(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeBrand(input) {
    var src = input || {};
    var siteName = safeTrim(src.site_name) || safeTrim(src.siteName) || DEFAULT_BRAND.site_name;
    var tagline = safeTrim(src.tagline) || DEFAULT_BRAND.tagline;
    var logoUrl = safeTrim(src.logo_url) || safeTrim(src.logoUrl) || DEFAULT_BRAND.logo_url;
    var faviconUrl = safeTrim(src.favicon_url) || safeTrim(src.faviconUrl) || DEFAULT_BRAND.favicon_url;

    return {
      site_name: siteName,
      siteName: siteName,
      tagline: tagline,
      logo_url: logoUrl,
      logoUrl: logoUrl,
      favicon_url: faviconUrl,
      faviconUrl: faviconUrl
    };
  }

  function getCachedBrand() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeBrand(JSON.parse(raw)) : null;
    } catch (_) {
      return null;
    }
  }

  function persistBrand(brand) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeBrand(brand)));
    } catch (_) {}
  }

  function markImageLoaded(img, wrapper) {
    img.style.display = 'block';
    if (wrapper) wrapper.classList.add('has-brand-logo');
  }

  function markImageFailed(img, wrapper, brand) {
    img.style.display = 'none';
    if (wrapper) wrapper.classList.remove('has-brand-logo');

    var initials = wrapper && wrapper.querySelector('[data-brand-initials]');
    if (initials) {
      initials.textContent = (brand.site_name || 'LP').slice(0, 2).toUpperCase();
    }
  }

  function setImageTarget(el, url, brand) {
    if (!el || !url) return;

    var tagName = (el.tagName || '').toUpperCase();
    var wrapper = el.closest('[data-brand-logo-wrap], .lp-sb-logo-icon, .lp-logo, .logo-mark, .admin-logo-mark');

    if (tagName === 'IMG') {
      el.alt = brand.site_name || 'LogicPals';
      el.onload = function () {
        markImageLoaded(el, wrapper);
      };
      el.onerror = function () {
        markImageFailed(el, wrapper, brand);
      };

      if (el.src !== url) el.src = url;
      if (el.complete && el.naturalWidth > 0) markImageLoaded(el, wrapper);
      return;
    }

    var existing = el.querySelector('img[data-brand-logo]');
    if (!existing) {
      existing = document.createElement('img');
      existing.setAttribute('data-brand-logo', '');
      existing.alt = brand.site_name || 'LogicPals';
      existing.style.width = '100%';
      existing.style.height = '100%';
      existing.style.objectFit = 'contain';
      existing.style.borderRadius = 'inherit';

      el.innerHTML = '';
      el.appendChild(existing);
    }

    setImageTarget(existing, url, brand);
  }

  function setText(selector, value) {
    if (!value) return;

    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  function setFavicon(url) {
    if (!url) return;

    var icon =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]');

    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.appendChild(icon);
    }

    icon.href = url;
  }

  function applyBrandSettings(input, options) {
    var brand = normalizeBrand(input || getCachedBrand() || DEFAULT_BRAND);
    var opts = options || {};

    if (opts.persist) persistBrand(brand);

    if (document.title) {
      document.title = document.title.replace(/LogicPals/g, brand.site_name);
    }

    document.querySelectorAll([
      '[data-brand-logo]',
      '.brand-logo img',
      '.logo img',
      '.lp-logo-img',
      '#siteLogo',
      '#adminLogo',
      '#adminSidebarBrandLogo'
    ].join(',')).forEach(function (el) {
      setImageTarget(el, brand.logo_url, brand);
    });

    document.querySelectorAll([
      '[data-brand-logo-wrap]',
      '.lp-sb-logo-icon',
      '.lp-logo',
      '.logo-mark',
      '.admin-logo-mark'
    ].join(',')).forEach(function (el) {
      if (!el.querySelector('img[data-brand-logo]')) {
        setImageTarget(el, brand.logo_url, brand);
      }
    });

    setText('[data-brand-name], .brand-name, .logo-name, .admin-brand-name', brand.site_name);

    document.querySelectorAll('[data-brand-tagline], .brand-tagline, .logo-subtitle, .admin-brand-subtitle').forEach(function (el) {
      if (el.classList.contains('lp-sb-logo-sub')) {
        el.textContent = 'ADMIN CONSOLE';
      } else {
        el.textContent = brand.tagline;
      }
    });

    setFavicon(brand.favicon_url);

    window.__LOGICPALS_ACTIVE_BRAND__ = brand;
    return brand;
  }

  async function refreshFromSupabase(sb) {
    if (!sb || !sb.from) {
      return applyBrandSettings();
    }

    try {
      var result = await sb
        .from('site_settings')
        .select('value')
        .eq('key', 'brand')
        .maybeSingle();

      if (result.error) throw result.error;

      var brand = result.data && result.data.value ? result.data.value : null;
      return applyBrandSettings(brand || getCachedBrand() || DEFAULT_BRAND, { persist: !!brand });
    } catch (err) {
      console.warn('[Brand Loader] Supabase refresh failed; using cached/default brand.', err);
      return applyBrandSettings(getCachedBrand() || DEFAULT_BRAND);
    }
  }

  window.LPBrand = {
    applyBrandSettings: applyBrandSettings,
    refreshFromSupabase: refreshFromSupabase,
    getActiveBrand: function () {
      return window.__LOGICPALS_ACTIVE_BRAND__ || normalizeBrand(getCachedBrand() || DEFAULT_BRAND);
    },
    storageKey: STORAGE_KEY
  };

  function boot() {
    applyBrandSettings(getCachedBrand() || DEFAULT_BRAND);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.addEventListener('logicpals:brand-updated', function (event) {
    applyBrandSettings(event.detail || DEFAULT_BRAND, { persist: true });
  });
})();