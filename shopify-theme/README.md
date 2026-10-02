# HOMESTRO Shopify Theme — Design B

Eigenständiges Shopify-Online-Store-2.0-Theme für den deutschen HOMESTRO Store.

## Funktionen

- Responsive Marketplace-Startseite in der Reihenfolge Lifestyle-Hero, sieben bildbasierte Kategorien, Bestseller, drei Promo-Kacheln, Abschlussbanner und konfigurierbare Serviceleiste; der Newsletter ist optional und standardmäßig deaktiviert
- Dynamische Produkt- und Kollektionsseiten mit vollständiger Variantenauswahl, Preisen, Verfügbarkeit, Variantenbildern, Facettenfiltern und Sortierung
- AJAX-Warenkorb auf Produktseiten, vollständige Warenkorbseite sowie ergänzende und ähnliche Produktempfehlungen
- Suche, Inhaltsseiten und deutschsprachige 404-Seite
- Anpassbare Sections, Navigationen, Bilder, Kollektionen und Inhalte im Theme Editor
- Logo, Hero-, Kategorie-, Promo- und Abschlussbilder werden im Theme Editor gewählt; Kategorie- und Produktbereiche verwenden ausschließlich ausgewählte Shopify Collections, nie fest verdrahtete Produkt- oder Varianten-IDs
- Semantisches, tastaturbedienbares Markup und responsive Bilder

## Lokale Qualitätsprüfung

```sh
shopify theme check --path shopify-theme
```

Eine Vorschau darf ausschließlich in einem Entwicklungs- oder unveröffentlichten Theme erfolgen:

```sh
shopify theme dev --path shopify-theme --store STORE.myshopify.com
```

Dieses Repository enthält keine Veröffentlichungsautomatik. Das Theme niemals ohne ausdrückliche Freigabe auf das Live-Theme übertragen oder veröffentlichen.

Vor einer Draft-Vorschau müssen im Theme Editor das echte helle HOMESTRO-Logo, die Lifestyle-Bilder und die gewünschten Collections gewählt werden. Ohne hochgeladenes Logo zeigt der schwarze Header eine neutrale HOMESTRO-Wortmarke mit grünem Strich; es wird bewusst kein erfundenes Symbol verwendet.
