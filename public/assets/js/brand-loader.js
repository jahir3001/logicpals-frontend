(function () {
  const BRAND = {
    siteName: "LogicPals",
    tagline: "THINK. DON'T MEMORIZE.",
    logoUrl: "https://ovszuxerimhbmzfblzkgd.supabase.co/storage/v1/object/public/blog-media/brand/logo-1780916136780.png",
    faviconUrl: ""
  };

  function setImage(el, url) {
    if (!el || !url) return;
    if (el.tagName === "IMG") {
      el.src = url;
      el.alt = BRAND.siteName;
    } else {
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.textContent = "";
    }
  }

  function applyBrand() {
    document.title = document.title.replace(/LogicPals/g, BRAND.siteName);

    document.querySelectorAll(
      '[data-brand-logo], .brand-logo img, .logo img, .lp-logo-img, #siteLogo, #adminLogo'
    ).forEach((el) => setImage(el, BRAND.logoUrl));

    document.querySelectorAll(
      '.lp-logo, .logo-mark, .admin-logo-mark'
    ).forEach((el) => {
      if (!el.querySelector("img")) {
        el.innerHTML = "";
        const img = document.createElement("img");
        img.src = BRAND.logoUrl;
        img.alt = BRAND.siteName;
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
        el.appendChild(img);
      }
    });

    document.querySelectorAll(
      '[data-brand-name], .brand-name, .logo-name, .admin-brand-name'
    ).forEach((el) => {
      el.textContent = BRAND.siteName;
    });

    document.querySelectorAll(
      '[data-brand-tagline], .brand-tagline, .logo-subtitle, .admin-brand-subtitle'
    ).forEach((el) => {
      el.textContent = BRAND.tagline;
    });

    if (BRAND.faviconUrl) {
      let favicon = document.querySelector('link[rel="icon"]');
      if (!favicon) {
        favicon = document.createElement("link");
        favicon.rel = "icon";
        document.head.appendChild(favicon);
      }
      favicon.href = BRAND.faviconUrl;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyBrand);
  } else {
    applyBrand();
  }
})();