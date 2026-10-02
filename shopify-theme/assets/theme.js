document.documentElement.classList.remove('no-js');

const rootPath = window.Shopify?.routes?.root || '/';

function showToast(message, isError = false) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('toast--error', isError);
  toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 3000);
}

function updateCartCount(count) {
  document.querySelectorAll('[data-cart-count]').forEach((element) => {
    element.textContent = count;
    element.hidden = count === 0;
  });
}

function setProductMedia(productRoot, mediaId, imageUrl) {
  if (!mediaId && !imageUrl) return;
  const mainImage = productRoot.querySelector('[data-product-main-image]');
  const matchingThumbnail = mediaId
    ? productRoot.querySelector(`[data-media-thumbnail][data-media-id="${mediaId}"]`)
    : null;
  const nextImageUrl = imageUrl || matchingThumbnail?.dataset.imageSrc;

  if (mainImage && nextImageUrl) {
    mainImage.src = nextImageUrl;
    mainImage.removeAttribute('srcset');
    if (mediaId) mainImage.dataset.mediaId = mediaId;
  }

  productRoot.querySelectorAll('[data-media-thumbnail]').forEach((thumbnail) => {
    const active = String(thumbnail.dataset.mediaId) === String(mediaId);
    thumbnail.classList.toggle('is-active', active);
    thumbnail.setAttribute('aria-pressed', String(active));
  });
}

function initializeProduct(productRoot) {
  const variantsElement = productRoot.querySelector('[data-product-variants]');
  const form = productRoot.querySelector('[data-ajax-cart]');
  if (!variantsElement || !form) return;

  let variants;
  try {
    variants = JSON.parse(variantsElement.textContent);
  } catch (error) {
    console.error('Variant data could not be parsed.', error);
    return;
  }

  const optionSelects = [...form.querySelectorAll('[data-option-select]')];
  const variantIdInput = form.querySelector('[data-variant-id]');
  const price = productRoot.querySelector('[data-product-price]');
  const comparePrice = productRoot.querySelector('[data-product-compare-price]');
  const availability = productRoot.querySelector('[data-product-availability]');
  const submitButton = form.querySelector('[data-add-to-cart]');
  const submitText = form.querySelector('[data-add-to-cart-text]');

  function renderVariant(variant) {
    const exists = Boolean(variant);
    const available = exists && variant.available;

    variantIdInput.value = exists ? variant.id : '';
    variantIdInput.disabled = !exists;
    submitButton.disabled = !available;
    submitButton.dataset.available = String(available);
    submitText.textContent = exists ? (available ? 'In den Warenkorb' : 'Ausverkauft') : 'Nicht verfügbar';

    if (exists) {
      price.textContent = variant.price;
      comparePrice.textContent = variant.compareAtPrice || '';
      comparePrice.hidden = !variant.compareAtPrice || variant.compareAtPrice === variant.price;
      availability.innerHTML = available
        ? '<span class="status-dot"></span> Auf Lager'
        : 'Derzeit nicht verfügbar';
      setProductMedia(productRoot, variant.featuredMediaId, variant.featuredImage);

      const url = new URL(window.location.href);
      url.searchParams.set('variant', variant.id);
      window.history.replaceState({}, '', url);
    } else {
      comparePrice.hidden = true;
      availability.textContent = 'Diese Kombination ist nicht verfügbar';
    }
  }

  function selectVariant() {
    const selectedOptions = optionSelects.map((select) => select.value);
    const variant = variants.find((item) =>
      item.options.length === selectedOptions.length &&
      item.options.every((option, index) => option === selectedOptions[index])
    );
    renderVariant(variant);
  }

  optionSelects.forEach((select) => select.addEventListener('change', selectVariant));

  productRoot.querySelectorAll('[data-media-thumbnail]').forEach((thumbnail) => {
    thumbnail.addEventListener('click', () => {
      setProductMedia(productRoot, thumbnail.dataset.mediaId, thumbnail.dataset.imageSrc);
    });
  });

  const quantityInput = form.querySelector('input[name="quantity"]');
  form.querySelector('[data-quantity-minus]')?.addEventListener('click', () => {
    quantityInput.value = Math.max(1, Number.parseInt(quantityInput.value, 10) - 1 || 1);
  });
  form.querySelector('[data-quantity-plus]')?.addEventListener('click', () => {
    quantityInput.value = Math.max(1, Number.parseInt(quantityInput.value, 10) + 1 || 1);
  });
}

async function addToCart(form) {
  const button = form.querySelector('[data-add-to-cart]');
  const spinner = form.querySelector('.button__spinner');
  const message = form.querySelector('[data-product-form-message]');

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (spinner) spinner.hidden = false;
  if (message) message.hidden = true;

  try {
    const response = await fetch(`${rootPath}cart/add.js`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: new FormData(form)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.description || result.message || 'Das Produkt konnte nicht hinzugefügt werden.');

    const cartResponse = await fetch(`${rootPath}cart.js`, { headers: { Accept: 'application/json' } });
    if (!cartResponse.ok) throw new Error('Der Warenkorb konnte nicht aktualisiert werden.');
    const cart = await cartResponse.json();
    updateCartCount(cart.item_count);
    showToast('Zum Warenkorb hinzugefügt');
  } catch (error) {
    const errorMessage = error.message || 'Bitte versuchen Sie es erneut.';
    if (message) {
      message.textContent = errorMessage;
      message.hidden = false;
    }
    showToast(errorMessage, true);
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = button.dataset.available !== 'true';
    if (spinner) spinner.hidden = true;
  }
}

function initializeRecommendations(section) {
  if (!section.dataset.url || section.dataset.loaded === 'true') return;
  section.dataset.loaded = 'true';
  const slot = section.dataset.recommendationIntent === 'complementary'
    ? document.querySelector('[data-complementary-slot]') : null;
  if (slot) slot.append(section);
  fetch(section.dataset.url)
    .then((response) => {
      if (!response.ok) throw new Error('Recommendations request failed');
      return response.text();
    })
    .then((htmlText) => {
      const html = new DOMParser().parseFromString(htmlText, 'text/html');
      const replacement = html.querySelector('[data-product-recommendations]');
      if (replacement?.querySelector('.product-card')) {
        section.innerHTML = replacement.innerHTML;
        if (slot) {
          slot.hidden = false;
          slot.closest('.product').classList.add('product--with-complementary');
        }
      } else section.remove();
    })
    .catch(() => section.remove());
}

const menuToggle = document.querySelector('[data-menu-toggle]');
const navigation = document.querySelector('[data-nav]');
menuToggle?.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('[data-product-root]').forEach(initializeProduct);
document.querySelectorAll('[data-product-recommendations]').forEach(initializeRecommendations);

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-ajax-cart]');
  if (!form) return;
  event.preventDefault();
  addToCart(form);
});

document.querySelectorAll('[data-sort-select]').forEach((select) => {
  select.addEventListener('change', () => {
    const form = select.form;
    if (!form) return;
    select.closest('[data-facets-root]').querySelectorAll('[data-sort-select]').forEach((otherSelect) => {
      otherSelect.value = select.value;
    });
    form.querySelector('input[name="sort_by"]').value = select.value;
    form.requestSubmit();
  });
});

const facetsPanel = document.querySelector('[data-facets-panel]');
const facetsOpen = document.querySelector('[data-facets-open]');
function closeFacets() {
  document.body.classList.remove('facets-open');
  facetsOpen?.setAttribute('aria-expanded', 'false');
}
facetsOpen?.addEventListener('click', () => {
  document.body.classList.add('facets-open');
  facetsOpen.setAttribute('aria-expanded', 'true');
  facetsPanel?.querySelector('input, button, select, a')?.focus();
});
document.querySelectorAll('[data-facets-close]').forEach((button) => button.addEventListener('click', closeFacets));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFacets();
});
