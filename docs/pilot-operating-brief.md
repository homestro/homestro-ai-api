# Oprava výběru zamítnutých produktů — 8. 10. 2026
Kontrola přes Railway potvrdila deployment 9776ddc1-da2b-49fb-8b00-eff4bb0fbb6d SUCCESS a běžící workerEnabled=true, publishingEnabled=true. Logy potvrdily nové publikace: Facebook https://www.facebook.com/122263627130172038/posts/122263929632172038 (17:47 UTC), Instagram https://www.instagram.com/p/DePgls5mBsC/ (17:50 UTC). Připojený persistentní volume /data 1024 MB je nyní doložený.

Oprava blokuje homestro-ai-rejected a homestro-qa-rejected při přebírání zdroje, ingestion i čerstvé kontrole před publikací, včetně uložených starších schválení. rejected pochází přímo z aktuálních Shopify tags, nikoli přepsatelných marketing_inputs. PreparationVersion=5 obnoví revize. Automatické schvalování nepouští dokumenty rejected=true. Validace 58/58 marketingových testů, včetně tří nových regresí.

Zbývá ověřit nasazení této změny. Zisk 10 EUR není současným priceReviewed=true potvrzen: bridge nastavuje landedCost=null a přebírá historicky schválené prodejní ceny. Vyhledávání a plně automatický DSers import nejsou touto změnou dokončené. Soukromé status/input API vyžaduje administrátorský klíč; Railway OAuth konektor poskytuje pouze názvy proměnných. Neprohlašovat kompletní ekonomický audit za hotový.

# Pilot — Homestro a MS Handwerk & Service
## Aktuální pokyn majitele 8. 10. 2026 19:40 Berlin — bez potvrzení médií
Mirko výslovně požádal odstranit požadavek na potvrzení dodavatele k fotografiím a videím. Tento aktuální pokyn nahrazuje starší požadavek mediálního potvrzení v tomto dokumentu. rightsVerified zůstává pravdivým auditním údajem; nepřepisuje se na true bez evidence. Je odstraněn jako podmínka v reviewedSource, ingestion, automatickém schvalování i jednorázovém testu. Rozhraní již nevyžaduje tento údaj. Publikace nadále vyžaduje zkontrolovaný obsah a cenu, aktivní dostupný produkt, připravená média, správné účty a publikační kvóty. Zvláštní Shopify štítek k právům ani souhlas dodavatele nejsou technickou podmínkou. Žádná placená Ads volání; adSpendEUR=0. PreparationVersion=4 zajistí obnovu starých blokovaných návrhů.

Validace: marketingová testovací sada včetně produktu s rightsVerified=false, který po obsahové kontrole dosáhne ready a ponechá údaj rightsVerified=false. Živé schválení a skutečné platformní odkazy je nutné ověřit po nasazení.

## Oprava přípravy před schválením — 8. 10. 2026
Automatické processProduct již nevrací pending před zavoláním ingestion. Runtime předává createSourceLocalizer: bez síťových AI volání sestaví německý návrh z existujících faktů Shopify. Chybějící zdroj nebo cizojazyčné údaje mají samostatný důvod SOURCE_COPY_REQUIRED / GERMAN_TRANSLATION_REQUIRED; tento adaptér není obecný strojový překladač. Zpracovaný německý popis může obsahovat jednu až tři doložené odrážky nebo věty, nemusí obsahovat přesně tři HTML li.

Nevyřešená publikační kontrola neblokuje přípravu textu. Scheduled neověřené položky vytvářejí previewOnly návrhy bez ffmpeg a stahování médií; worker previewOnly nikdy nepublikuje. Po potvrzení podkladů proběhne skutečné zpracování médií. Odstraněny tři uměle opakované titulky z chybového fallbacku. Cena „Ab“ používá nejnižší cenu dostupné varianty. Lokalizační cache používá nový preparationVersion=3 a ukládá pouze úspěšnou přípravu. Samotná příprava nedává práva k médiím ani nepotvrzuje věcnou správnost podkladů.

Validace: 54/54 marketingových testů prošlo, včetně zpracování produktu bez předchozího schválení, nulového kódování preview, jednoho faktu, chybějících faktů, odmítnutí anglického textu a blokování chybně schváleného preview. Automatická oprava odstraní HTML, emoji, nadbytečné mezery, duplicitní výhody a nadlimitní SEO délky a následně znovu validuje text. Změna produktové revize vyřadí staré drafty i při neúspěšné nové přípravě. Živě ověřeno 8. 10. 2026 v 17:34:58 UTC: deployment ba538573-986d-4fc5-b8ee-7b46b74b6667 SUCCESS, commit 30f899a13e81dc811f1c395e7409ee5aa17c4a66. CONTENT_PREPARED: 143 produktů prepared=true, 286 nových návrhů FB/IG. CATALOG_SYNC: processed=146, errors=0, pending=143. CONTENT_REVIEW_REQUIRED kleslo z 89 na 23; MEDIA_RIGHTS_REVIEW_REQUIRED=146 (souhrn zahrnuje i vyřazené záznamy). Worker i publikování zapnuté, žádná nová produktová publikace; historie published=4, draft_queued=294, superseded=600. Práva k médiím a 23 obsahových kontrol zůstávají publikačními podmínkami.

## Oprava 8. 10. 2026 — produktová fronta
Současné zadání majitele ruší obecné tipové kartičky. PILOT_BRAND_EDITORIAL_ENABLED=false; nepublikované redakční návrhy se při synchronizaci vyřadí a worker je blokuje před voláním Meta. Již publikované příspěvky zůstávají v historii.

Audit před opravou: produkční služba synchronizuje 146 aktivních produktů, 143 pending, 0 nově schválených. Dodavatelský odkaz je informační provenance, nikoli publikační podmínka. Skutečné podmínky jsou ověřená práva k médiím, zkontrolovaný německý obsah, cena a dostupnost. Tyto podmínky se neobcházejí. Synchronizace nyní zaznamenává konkrétní důvody a status API vrací souhrn překážek i odkazy na publikace. Přehled pending vrací až 250 položek místo 10.

Publikační kvóty používají samostatné published_at. Migrace zachová nejstarší zaznamenaný published event a kontrola odkazů nemění čas publikace. Bez potvrzených práv nelze označit dodavatelské fotografie za ověřené; bez schválení platformy nelze prohlásit Google napojení za dokončené. Rozpočet Ads zůstává 0 EUR.

Lokální validace: 47/47 testů marketingové sady prošlo. Produkční commit d94f5bf287fabf957a19d9af2f371b589fe9b085, deployment 77e8be03-bbca-4350-b733-2fdbdfd2b2ef byl SUCCESS. Po restartu dne 8. 10. 2026 v 17:21:38 UTC: workerEnabled=true, publishingEnabled=true; CATALOG_SYNC processed=146, errors=0, pending=143. Souhrn uložených marketing_products uvádí MEDIA_RIGHTS_REVIEW_REQUIRED=146, CONTENT_REVIEW_REQUIRED=89; zahrnuje i dříve vyřazené položky. Fronta: superseded=28, draft_queued=290, published=4, žádné approved. Obecné kartičky jsou vyřazené z fronty. Novou produktovou publikaci tento běh nevytvořil.

Po restartu byly přes Meta přečteny existující odkazy: Facebook https://www.facebook.com/122263627130172038/posts/122263627112172038 a https://www.facebook.com/122263627130172038/posts/122263759748172038; Instagram https://www.instagram.com/p/DeIHPKVHfX8/ a https://www.instagram.com/p/DeLxcXQmGSZ/. Jde o historii, nikoli novou publikaci. Obecný přehled minulých konverzací nedoložil konkrétní komerční souhlas dodavatele k produktovým médiím. Zbývající obsahová a licenční kontrola není dokončená. Google a MS Handwerk nebyly touto opravou zprovozněny.

Aktualizováno 6. 10. 2026, odpolední kontrola. Tento dokument nahrazuje ranní podklady a slouží jako trvalý přehled zadání, ověřeného stavu a zbývajících kroků. Neobsahuje hesla ani tokeny.

## Trvalé zadání od Mirka
Jednou propojit správné účty a uložit potřebné údaje tak, aby se nemusely znovu předávat v chatu. Pilot má samostatně připravovat a zveřejňovat organický obsah pro Homestro a MS Handwerk & Service, udržovat přehled výsledků a běžet bez otevřeného chatu. Průběžný běh závisí na dostupném hostingu, potřebném kreditu API, platných oprávněních a zásobě použitelného obsahu.

Rozpočet placených kampaní zůstává 0 EUR. Požadavek „dokud budou peníze“ zde znamená provozní prostředky; není povolením k neomezenému utrácení ani změnou zákazu placených reklam. Placené Meta/Google Ads by vyžadovaly samostatné výslovné zadání a pevné limity.

Obsah veřejně v němčině, komunikace s Mirkem česky. Pro MS používat skutečné realizace a potvrzené služby. Nepřidávat vymyšlené ceny, akce, dostupnost termínů ani reference. Homestro: vynechat Lickmat z prvního testu, nepoužít elektrický masážní přístroj z posledního návrhu. Dříve vybraný první kandidát: https://homestro.de/products/quadratische-haarklammern-4er-set — před použitím znovu načíst aktuální cenu/varianty/dostupnost.

## Co je dnes doložené
- Railway Homestro AI Control: obě API služby a PostgreSQL Online, žádná služba s aktuálně hlášeným problémem.
- Produkční fixed-current deployment: 0bace761-fc09-40aa-b257-77ddeea632fa, SUCCESS z 5. 10. 2026 21:04 UTC.
- Jeho startup log: Pilot enabled=true, workerEnabled=false, publishingEnabled=false, syncOnce=false. Nejde o běžící automatickou publikaci.
- Poslední Meta ověření v témže deploymentu: chyba 190/463, published=false.
- PR https://github.com/homestro/homestro-ai-api/pull/68 je stále otevřený DRAFT, není sloučený ani nasazený. Obsahuje OAuth pro Homestro, šifrované uložení Page přístupu v PostgreSQL, stav spojení a kontroly. 16 nových testů prošlo; živé přihlášení není ověřené.
- Railway fixed-current obsahuje názvy Shopify/Meta tokenů a ID, DATABASE_URL a OPENAI_API_KEY. Hodnoty jsou před konektorem skryté. Neobsahuje názvy META_APP_ID, META_APP_SECRET, META_TOKEN_ENCRYPTION_KEY ani META_OAUTH_REDIRECT_URI. Existence proměnné nepotvrzuje funkční přístup.
- Aktivní účet Merchant Center Homestro.de 5447184929: 50 načtených položek, všech 50 NOT_ELIGIBLE_OR_DISAPPROVED. Aktuální diagnostika: misrepresentation a missing_shipping_no_shipping_service_defined_for_country. Misrepresentation postihuje i FREE_LISTINGS.
- Druhý účet Homestro 5680568022: 0 položek, web nepotvrzený. Hlášení chybějícího Google Ads propojení není důvodem zapínat placené reklamy v tomto projektu. Nepřepínat omylem na tento účet a bez důvodu nic nemazat.
- Dostupné Google Search Console propojení vrací prázdný seznam webů.
- Kód MS Handwerk pracuje v režimu DRAFT_ONLY, autoPublishingEnabled=false. Připravuje text pro Google profil, web a sociální sítě; neobsahuje automatický publikátor do Google Business Profile.
- API služby v Railway nemají připojený volume. Marketing používá soubory v /data/marketing. Odolnost těchto médií proti restartu/deploymentu není zajištěna persistentním volume.
- Databázové schéma a fronta Pilota v2 jsou zaměřené na Shopify produkty a kanály facebook/instagram; nemají plnou správu obou značek ani Google Business postů.

## Všechny zjištěné překážky a potřebné doplnění

| Oblast | Současný problém | Potřebný výsledek | Kdo dodá/udělá |
|---|---|---|---|
| Homestro Meta | Ruční token v posledním logu neplatný; nová oprava není nasazená | Dokončit nastavení Meta aplikace, nasadit OAuth, jednou autorizovat správnou Page + profesionální Instagram; ověřit publikaci na obou | Já kód a ověření; Mirko přihlášení/2FA a přístup do aplikace |
| Údaje Meta aplikace | Chybí ID/secret aplikace, šifrovací klíč a callback konfigurace | Uložit tajné údaje do soukromých proměnných Railway; v Meta povolit přesnou callback URL a potřebná oprávnění | App ID/secret z existující aplikace; klíč mohu vygenerovat, callback nastavit |
| MS Service Meta | Page a Instagram pro MS nejsou tímto auditem doložené; PR 68 ukládá jen Homestro spojení | Dohledat/vybrat správné účty MS a rozšířit spojení, frontu i limity podle značky | Já rozšíření; Mirko jednorázový výběr a souhlas v jeho účtu |
| Homestro Google produkty | 50 položek odmítnutých; shipping a Misrepresentation trvají | Prověřit skutečnou dopravu v cílových zemích, feed, checkout a veřejné podmínky; odstranit nedostatky obchodu a požádat o kontrolu, pokud je dostupná | Já audit/opravy podle přístupu; Google rozhoduje o schválení |
| Google MS Service | Aktuálně jen textový návrh, chybí doložené OAuth a API připojení | Ověřený správný Business Profile, účet/location ID, schválený Cloud projekt/API a Google offline OAuth | Já implementace; Mirko souhlas; Google API schválení |
| Weby/SEO | Google nelze používat jako sociální síť s libovolnými „posty do výsledků“; Search Console není připojeno | Homestro: produkty ve free listings a obsah webu; MS: příspěvky ve firemním profilu a obsah webu. Uložit oprávnění pro příslušný web/CMS a připojit Search Console pro měření | Já |
| Automatické schvalování | Fronta čeká na jednotlivé approved příspěvky; obecné „postuj“ zatím není implementovaná politika | Zavést trvale uložená pravidla, která automaticky pouští ověřený obsah a odkládají pouze výjimky; autorizace průběžné organické propagace pochází z dnešního zadání | Já |
| Zásoba obsahu | Produkty a zakázky nejsou společná trvale spravovaná knihovna obsahu; práva a ověřené údaje jsou vstupní podmínky | Jednou uložit zdroje, potvrzené texty, fotky/videa a rozsah jejich použití. Homestro číst z Shopify, MS z opravdových realizací. Nevyvozovat práva jen z toho, že foto pochází z AliExpressu | Já import/třídění; Mirko jen chybějící pravdivé údaje a nové materiály |
| Trvalá média | API bez volume; soubory mohou při redeploy zmizet | Persistentní volume nebo vhodné trvalé úložiště s veřejnými adresami pro platformy; ověřit po restartu | Já, po určení provozního limitu |
| Běh pro dvě značky | Worker vypnutý; aktuální limit je celkem 2 příspěvky/24 h pro FB+IG, ne zvlášť pro dvě firmy | Rozvrh, samostatné účty/fronty/limity podle značky a kanálu, prevence duplicit, postup pro nejistou publikaci | Já |
| Provozní peníze | Neověřený stav AI kreditu a fakturace hostingu; žádný uložený celkový měsíční strop | Jednou určit maximální měsíční provozní náklad a co při vyčerpání pozastavit. Uložit limit, kontrolovat náklady/chyby, nezapínat placené kampaně | Mirko jednorázový strop; já kontrola |
| Dohled a obnova | Chybí jednotný přehled obou značek; stav záloh a obnovení není potvrzený | Status spojení, poslední skutečné příspěvky s odkazy, fronta, chybové výjimky, dostupnost médií a zálohování; obnovit provoz bez ztráty historie | Já |

## Google: dva různé způsoby propagace
Homestro.de: Merchant Center produktový feed → bezplatné produktové nabídky, případně SEO obsah publikovaný na vlastním webu. Google si načítá produktový zdroj podle jeho nastavení; není nutné každý den ručně vkládat produkt. Načtení feedu nezaručuje schválení.

MS Handwerk & Service: Google Business Profile příspěvky a obsah ms-handwerkservice.de. Pro automatické posty vyžaduje Google přístup k Business Profile API. Aktuální dokumentace pro žádost o přístup uvádí správu ověřeného profilu aktivního alespoň 60 dní a web uvedený v profilu. Nelze proto slibovat schválení API ještě tentýž večer. Aktuální stav ověření MS a případné dřívější API schválení zatím nebyly živě doložené.

Pro Google OAuth použít offline přístup a trvale uložený šifrovaný refresh token, automaticky obnovovat krátkodobé access tokeny. Zrušené oprávnění může i zde vyžadovat nové přihlášení. Search Console měří hledání a indexaci; není publikátor reklam.

## Co Mirko dodá jednou
1. Přihlášení/souhlas se správnými Meta účty obou značek a Google účtem spravujícím Merchant Center/Business Profile. Hesla a tokeny se nemají vkládat do chatu.
2. Přístup do existující Meta aplikace a Google Cloud projektu, případně pomoc s jednorázovým schválením/ověřením. Pokud lze údaje dohledat přes autorizované připojení, znovu je nevyžadovat.
3. Potvrdit správné firemní kontakty, weby, oblast služeb a stálé texty MS, pouze co ještě není doložené. Nepožadovat znovu běžné údaje, které již máme uložené.
4. Chybějící údaje k použití materiálů/realizací a vstupní zásobu obsahu. Dříve dodané soubory dohledat a použít; nepožadovat nové nahrání, pokud jsou dostupné.
5. Měsíční strop technického provozu. Reklamní rozpočet zůstává 0 EUR. Nepožadovat každodenní ruční zadávání textů či tokenů.

## Co je potřeba průběžně / denně
Pilot si má sám načítat dostupné Shopify produkty, ceny a sklad; kontrolovat spojení, vybrat další vhodný obsah, připravit německé texty, zveřejnit podle rozvrhu, zaznamenat platformní ID/odkaz a zkontrolovat výsledek. Automaticky kontroluje limity a odkládá nejisté/nevhodné položky.

Mirko nemusí každý den zadávat nic. Občas dodá nové dokončené zakázky, fotografie/video nebo změnu služeb; poskytne nové přihlášení jen při zrušení přístupu. Zaplacený hosting a potřebný AI kredit zůstávají provozními podmínkami. Bez nové zásoby může systém pracovat se schválenými materiály, ale nemá donekonečna opakovat totožné příspěvky ani vymýšlet nové realizace.

## Co ukládat a kam
- Soukromé proměnné hostingu: app/client secrets a stabilní šifrovací klíč. Ne do chatu ani veřejného GitHubu.
- PostgreSQL: šifrované přístupy podle značky a platformy, účty, souhlasy/pravidla, podklady ke schválení a historii skutečných publikací.
- Trvalé úložiště médií: originály a publikovatelné varianty s adresami, které nepřestanou fungovat po restartu.
- Repozitář: kód, tento provozní brief a popis konfigurace bez tajných hodnot.
- Tento průběžně aktualizovaný soubor: známé skutečnosti, úkoly a výsledky. Uložení dokumentu samo o sobě nezapne workera ani nedává konektoru chybějící oprávnění.

## Co mohu udělat samostatně a kde je hranice
Mohu implementovat, testovat, ukládat kód a nastavení v povoleném rozsahu, připravovat obsah, udržovat frontu a ověřovat výsledky dostupnými přístupy. Pilot na serveru musí nést běžnou automatizaci; tato konverzace neběží nepřetržitě sama.

Nemohu za majitele dokončit 2FA, bezpečnostní výzvu nebo souhlas s účtem. Nemohu slíbit, že Meta/Google nikdy přístup neodvolají, ani obejít schválení Google API či obchodu. V takové výjimce má Pilot jasně ukázat „znovu připojit“ a znovu nepoptávat všechny firemní údaje.

## Pořadí dokončení a průkazné testy
1. Dokončit a nasadit PR 68 + správně nakonfigurovat Meta aplikaci; ověřit Facebook i Instagram Homestro veřejnými odkazy.
2. Zajistit trvalé uložení médií, spojení po restartu a uložené schvalovací/provozní limity.
3. Rozšířit účty a frontu pro MS Service, připojit jeho Meta.
4. Vyřešit aktuální shipping a Misrepresentation v Merchant Center 5447184929; doložit schválené free listings.
5. Připojit Google Business Profile MS, jakmile splňuje podmínky API, a ověřit skutečný příspěvek.
6. Zapnout plánovaný běh, ověřit jej bez otevřeného chatu a po restartu. U každé značky uložit skutečný platformní příspěvek/odkaz a poslední úspěšný běh.
7. Jednotný přehled má ukazovat: běží / čeká na obsah / chybí kredit / znovu připojit / platforma blokuje / nejasná publikace k ověření.

Dnešní stav je audit a uložené zadání, nikoli prohlášení, že všechna propojení již automaticky fungují.

## Technické identifikátory pro pokračování
Repo: homestro/homestro-ai-api. PR 68 branch: codex/meta-persistent-connection-20261006.
Railway project: 75e35227-3a04-439f-9c53-fc78556dd6e8.
Production environment: a543780b-7075-4693-bb1c-8dc437649ff8.
Canonical service: homestro-ai-api-fixed-current, ID 3ee64de3-7855-4b84-a866-43cc79bc56d1.
API origin: https://homestro-ai-api-fixed-current-production.up.railway.app.
Google feed v1: /feeds/google-organic.xml (výchozí limit 50 položek variant).
Google feed v2: /feeds/google-organic-v2.xml (vyžaduje připravené produkty a konfiguraci).
Meta OAuth callback PR 68: /auth/meta/callback; setup page: /connect/meta.
Hodnoty ID účtů MS a schválení Google API jsou dosud nedoložené; nevyplňovat vymyšlená ID.

## Zdroje a omezení dnešní kontroly
Railway environment status, názvy proměnných, startup log aktuálního deploymentu; GitHub PR/kód/schéma; živá diagnostika obou Merchant Center účtů; seznam připojených Search Console webů. Historické odpovědi o zveřejněném Google příspěvku MS nejsou dokladem dnešního API napojení.

- https://developers.google.com/my-business/content/prereqs
- https://developers.google.com/my-business/content/posts-data
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://support.google.com/merchants/answer/13692890?hl=en


## Original editorial fallback — 6 October 2026
The owner explicitly requested a workable alternative to uncertain supplier media. PILOT_BRAND_EDITORIAL_ENABLED=true enables 14 original German household tips, each with an original typographic JPEG generated by ffmpeg (no supplier image, product likeness, prices, reviews or invented service claims). The original manifest is validated again immediately before publication. This lane uses the existing persisted queue, Meta credentials, global/channel quotas, Berlin hours, history verification and recovery hold. It does not approve supplier media or enter Merchant product feeds. Copies are not endlessly repeated; after all 14 topics have been published on both channels, this batch is exhausted and needs more original content. No paid AI or Ads call is added.

Before claiming live operation, check EDITORIAL_READY, approval count, worker status and actual remote publication links. Existing posts consume the 24-hour quota; queued editorial content is not proof of new live publication. MS Service stays separate and Merchant suspension is not fixed by editorial posts.

# Organic social implementation — 10 October 2026

The owner authorized implementation of the free additional-channel route.
TikTok and Pinterest connector code is prepared against main
86c3ac3946a71685571cd25a8f122b436e7e4f39. It uses a separate durable
marketing_social_posts queue, existing product media/copy, revision checks,
deduplication, Berlin hours and one post per channel per rolling 24 hours.
No additional AI/video generator or Ads endpoint is used. Default social flags are
off; missing credentials must not disable existing Meta publishing.

TikTok requires genuine per-post preview and express consent. The owner review
page implements these; global autopilot authorization must never fabricate them.
Pinterest can reuse the existing reviewed-organic autonomy policy. Accepted remote
posts without public URLs remain pending. Draft delivery and ambiguous writes are
held for recovery and never reported as public publication.

Implementation tests are local verification only. Owner Zernio signup/OAuth,
provider secrets, deployment, PostgreSQL migration and real public platform links
are not yet verified. No claim of live TikTok/Pinterest operation is made.
Setup and exact variables: docs/social-organic-setup.md.
Reviewable GitHub change: https://github.com/homestro/homestro-ai-api/pull/79
(draft, not merged/deployed). The initial commit is
6d790e994ed1282965e474ee1eb07d67c404cd2e. Local marketing regression tests passed
89/89, including real FFmpeg rendering; subsequent read-failure regression raises
the suite to 90 tests. This PR is implementation evidence, not a live post link.
Zernio currently advertises two connected accounts free; do not add a card or third
account. Existing Railway/OpenAI running costs remain.

