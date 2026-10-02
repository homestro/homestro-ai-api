'use strict';

const EU_WAREHOUSES = new Map([
  ['DE', 'Germany'], ['GERMANY', 'Germany'], ['DEUTSCHLAND', 'Germany'],
  ['PL', 'Poland'], ['POLAND', 'Poland'], ['POLEN', 'Poland'],
  ['FR', 'France'], ['FRANCE', 'France'], ['FRANKREICH', 'France'],
  ['ES', 'Spain'], ['SPAIN', 'Spain'], ['SPANIEN', 'Spain'],
  ['CZ', 'Czechia'], ['CZECHIA', 'Czechia'], ['CZECH REPUBLIC', 'Czechia'], ['TSCHECHIEN', 'Czechia'],
  ['BE', 'Belgium'], ['BELGIUM', 'Belgium'], ['BELGIEN', 'Belgium'],
  ['NL', 'Netherlands'], ['NETHERLANDS', 'Netherlands'], ['NIEDERLANDE', 'Netherlands'],
  ['AT', 'Austria'], ['AUSTRIA', 'Austria'], ['OSTERREICH', 'Austria'],
  ['IT', 'Italy'], ['ITALY', 'Italy'], ['ITALIEN', 'Italy']
]);

const DIRECT_FIELDS = /^(shipFromCountry|ship_from_country|shipsFrom|ships_from|shippingFrom|shipping_from|warehouseCountry|warehouse_country|warehouseLocation|warehouse_location|warehouseCode|warehouse_code|warehouse|dispatchFrom|dispatch_from|dispatchCountry|dispatch_country|originCountry|origin_country|originCountryCode|origin_country_code|fulfillmentCountry|fulfillment_country)$/i;
const CONTAINER_FIELDS = /^(shipping|logistics|delivery|warehouse|warehouses|variants|skus|skuProperties|productOptions|offers)$/i;
const DESTINATION_FIELDS = /^(shipTo|shipToCountry|destination|destinationCountry|country|locale|currency|searchQuery|keyword|title|name)$/i;

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
}

function countryFromValue(value) {
  if (value && typeof value === 'object') {
    for (const key of ['code', 'countryCode', 'country', 'name', 'value', 'location']) {
      const found = countryFromValue(value[key]);
      if (found) return found;
    }
    return '';
  }
  const cleaned = normalize(value).replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  if (EU_WAREHOUSES.has(cleaned)) return EU_WAREHOUSES.get(cleaned);
  const labelled = cleaned.match(/(?:SHIP(?:S|PING)? FROM|DISPATCH(?:ES)? FROM|WAREHOUSE(?: LOCATION)?|VERSAND AUS)\s*[: ]\s*([A-Z ]{2,24})/);
  return labelled ? (EU_WAREHOUSES.get(labelled[1].trim()) || '') : '';
}

function explicitHunterWarehouseQuery(value) {
  const q = normalize(value).replace(/\s+/g, ' ');
  const country = q.match(/^(GERMANY|DEUTSCHLAND|POLAND|POLEN|FRANCE|FRANKREICH|SPAIN|SPANIEN|CZECHIA|CZECH REPUBLIC|TSCHECHIEN|BELGIUM|BELGIEN|NETHERLANDS|NIEDERLANDE|AUSTRIA|OSTERREICH|ITALY|ITALIEN) WAREHOUSE\b/);
  if (country) return EU_WAREHOUSES.get(country[1]) || '';
  if (/^EU (?:STOCK|WAREHOUSE)\b/.test(q)) return 'EU';
  return '';
}

function detectEuWarehouse(item) {
  const evidence = [];
  function visit(value, path, trustedContainer) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (DESTINATION_FIELDS.test(key) && !(trustedContainer && /^(country|countryCode|code|location)$/i.test(key))) continue;
      const direct = DIRECT_FIELDS.test(key);
      const container = trustedContainer || CONTAINER_FIELDS.test(key);
      if (direct || (container && /^(country|countryCode|code|location)$/i.test(key))) {
        const country = countryFromValue(child);
        if (country) evidence.push({ country, path: [...path, key].join('.'), value: String(typeof child === 'object' ? JSON.stringify(child) : child) });
      }
      if (child && typeof child === 'object') visit(child, [...path, key], container);
    }
  }
  visit(item, [], false);
  if (!evidence.length) {
    // This scraper returns the exact Hunter query in searchKeyword but often omits
    // ship-from as a separate field. Only our explicit warehouse query grammar is
    // accepted here; ordinary product titles/keywords are never treated as proof.
    const queryCountry = explicitHunterWarehouseQuery(item?.searchKeyword);
    if (queryCountry) evidence.push({country:queryCountry,path:'searchKeyword',value:String(item.searchKeyword),kind:'hunter-query'});
  }
  const first = evidence[0];
  return { confirmed: Boolean(first), country: first?.country || '', evidence };
}

module.exports = { detectEuWarehouse, countryFromValue, explicitHunterWarehouseQuery };
