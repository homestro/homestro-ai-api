'use strict';

// A gallery is ready only when every retained image passes. One good image
// cannot conceal a misleading variant, ad banner, or an unexamined next page.
async function checkGallery(images, checkImage, {hasNextPage = false} = {}) {
  const outcomes = new Array(images.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(3, images.length)}, async () => {
    while (next < images.length) {
      const index = next++;
      try { outcomes[index] = await checkImage(images[index]) === true; }
      catch { outcomes[index] = false; }
    }
  }));
  const passed = outcomes.filter(Boolean).length;
  const failedIds = images.filter((_, i) => !outcomes[i]).map(image => image.id);
  return {verified: images.length > 0 && !hasNextPage && passed === images.length,
    checked: images.length, passed, failedIds, hasNextPage};
}
module.exports = {checkGallery};
