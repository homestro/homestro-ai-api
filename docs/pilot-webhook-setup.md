# Jednorázové propojení plateb Shopify → Pilot

Přijímač používá existující Railway službu a trvalé úložiště. Reklamy zůstávají vypnuté na 0 EUR. Žádný Meta pixel, katalog, přístupový token ani Shopify aplikaci není potřeba kvůli tomuto přijímači znovu vytvářet.

## Přesná konfigurace

V Shopify: **Nastavení → Oznámení → Webhooky**. Nejdřív zkontrolovat existující webhooky a nevytvářet shodnou událost se stejnou adresou podruhé.

Všechny čtyři události mají formát **JSON** a stejnou adresu:

`https://homestro-adtech-pilot-production.up.railway.app/webhooks/shopify/orders`

| Událost v Shopify | Topic | Účel |
|---|---|---|
| Order payment | orders/paid | Potvrzení zaplacené objednávky |
| Order update | orders/updated | Zneplatnění při změně platebního stavu |
| Order cancellation | orders/cancelled | Storno |
| Refund create | refunds/create | Vrácení peněz |

Zvolit stejnou podporovanou verzi pro všechny, např. **2026-07**.

Podpisový klíč z této sekce Shopify uložit soukromě v proměnných služby **homestro-adtech-pilot** jako **SHOPIFY_WEBHOOK_SECRET**. Nejde o API access token ani client secret aplikace. Klíč nevkládat do chatu, dokumentace, GitHubu ani webhookové URL. Bez něj přijímač vrací 503 a nikdy nepřijme platbu jako ověřenou.

## Ověření

`https://homestro-adtech-pilot-production.up.railway.app/webhooks/shopify/setup` ukáže, zda je podpisová konfigurace přítomná. Samotná tato hodnota nepotvrzuje správnost klíče, registraci webhooků nebo doručení.

Shopify **Send test** ověřuje pouze dopravu. Testovací objednávka nesmí otevřít reklamy. Kontrolovat HTTP doručení a privátní stav přijímače, nikoli označit vzorek za prodej. Skutečný placený provoz vyžaduje ověřené měření správným Meta datasetem a samostatně otevřené původní reklamní přepínače/limity; webhook je důkaz platby pro bezpečnostní zámek, nenahrazuje Meta konverzní měření.

Nedoporučuje se vytvářet placenou objednávku jen kvůli testu. Bez nového skutečného zaplacení není doložena živá platební událost.
