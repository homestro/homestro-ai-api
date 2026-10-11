## MS Handwerk Google Business automation — 11 October 2026

Implementation is prepared on branch `codex/ms-google-auto-publishing-20261011` in the GitHub pull request. It adds a separate Google Business Profile OAuth connector for MS Handwerk & Service, encrypted persisted credentials, an owner-authorized profile picker restricted to the exact MS Handwerk & Service profile name, a durable post queue, and a 60-second worker. The publisher is gated off unless Google OAuth settings and `GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED=true` are present. The default cap is one post in a rolling 24-hour window. Posts use only supplied completed-job details; the generic template no longer promises unverified prices, availability or free inspections. Google posts are not sent to Homestro or Meta.

The worker records Google’s returned post ID and only marks a post published when its state is LIVE. A missing/ambiguous remote outcome remains held for recovery and is not sent again automatically. The owner can connect Google, choose the MS profile and enter completed-job details at `/ms-handwerk-google-connect`. The worker can publish queued content without a chat session, but it does not invent new customer jobs or details. Organic only; adSpendEUR remains 0.

Local validation: 4 Google publishing tests and 4 MS Handwerk organic draft tests pass; JavaScript syntax check passes. Current Railway production service `homestro-ai-api-fixed-current` is deployment `5944860d-6b1b-4b25-9ccd-db3b5ecb4539` SUCCESS. Its live variable-name inventory has no `GOOGLE_BUSINESS_*` settings, and this implementation is not yet deployed or connected to a Google account. No Google post is claimed. Google API access approval, OAuth client configuration and account-owner consent remain required before the Google feature can publish; Google requires the applicant to manage a verified Business Profile active for 60+ days and have the business website listed on the profile.

---

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
(merged and deployed successfully on 10 October 2026; merge commit
7c71f474041e0a621a097d0273e009db440ae6b3). The initial commit is
6d790e994ed1282965e474ee1eb07d67c404cd2e. Local marketing regression tests passed
89/89, including real FFmpeg rendering; subsequent read-failure regression raises
the suite to 90 tests. This PR is implementation evidence, not a live post link.
Zernio currently advertises two connected accounts free; do not add a card or third
account. Existing Railway/OpenAI running costs remain.

Owner screenshots confirm TikTok @homestroo and Pinterest @homestro0684 connected,
with public board Homestro – Ideen für Zuhause selected as current. Railway
confirms ZERNIO_API_KEY exists; OAuth tools redact its value. Social publishing
is still disabled. A copied Pinterest account ID is malformed (25 characters);
the opt-in PILOT_SOCIAL_CHECK_CONNECTION startup check reads accounts and boards
using the server-held key and logs only public IDs, names and privacy. It performs
no writes and emits sanitized failure codes. Two targeted diagnostic tests pass.

10 October, 20:33 Berlin: owner review screenshot shows individual TikTok consent
and an approved queue entry. Connection check confirmed @homestroo, @homestro0684
and public board 1094585953125321154. Corrected Pinterest account ID to
6aca3f628a43e7f438cb0f87; social integration and publishing variables enabled,
deployment fb4cd590-deec-4872-989d-e73c4e793dce succeeded. Review UI now displays
smaller linked photo previews, collapses successfully approved cards, scrolls to
the next card and shows remaining approvals. Per-post consent is unchanged;
generated browser script syntax checked. A queued approval is not a public link.

10 October, 20:40 Berlin: owner explicitly requested every-four-hour publishing
on all four connected networks and batch TikTok approval. Added validated
PILOT_PUBLISH_EVERY_HOURS and PILOT_PUBLISH_AROUND_CLOCK configuration, persisted
per-channel timestamp spacing, six-post rolling per-channel caps and a 12-post
Meta total cap. Night publishing is opt-in; duplicate/recovery/stock guards remain.
TikTok batch UI selects displayed drafts, requires an explicit common privacy and
interaction choice plus actual preview/consent for the selected manifest, sends
revision-bound approvals, shows partial errors and resets consent on selection
changes. It never gives consent for later unseen drafts. Tests: 101/101 pass,
including four-hour/overnight/cap scenarios, stale draft consent and the actual
generated UI script exercised in a DOM harness for successful/partial batches.



## Owner-authorized balanced organic publishing — 10 October 2026, 20:56 Berlin
Mirko explicitly delegated the best publishing settings after official-policy
research. Implemented balanced-v1: Facebook/Instagram maximum two each per rolling
24 hours, eight-hour minimum; TikTok maximum four with four-hour minimum; Pinterest
maximum six with two-hour minimum. New submissions run 09:00–22:00 Berlin only.
No overnight or catch-up flood. Exact-media references on one channel within 30
days are suppressed across product IDs. This is not a visual similarity classifier
or guarantee of original content. Existing stock/revision/product guards, recovery
holds, commercial TikTok disclosure and authentic preview/batch consent remain.
Pinterest descriptions no longer duplicate the long URL; links remain in the
provider destination field. Only complete trailing benefit sentences are omitted
when required to meet 800 characters. No new AI/Ads/paid video service added.
108/108 marketing tests passed, including real FFmpeg and batch-review harness.
Startup ORGANIC_PUBLISH_POLICY logs and authenticated status expose per-channel
limits. Deployment verification must use the actual new commit and Railway logs;
this record does not itself prove a new live TikTok/Pinterest post.

Queue selection now reserves up to 20 approved candidates per channel so a large
TikTok batch cannot starve Pinterest when TikTok is capped. First balanced release
2e2556ec848b47c851e3f0bad60d687533e565bb reached Railway SUCCESS on deployment
a2c65129-59a6-424d-b220-e119bc85f125. Final fairness patch needs its own deployment
verification; no new public TikTok/Pinterest post is asserted by this change.


## Marketing quality and publication evidence — 10 October 2026
Owner requested marketing first, using existing Shopify media and no paid ads.
Balanced carousels inspect at most six source images using cached local Tesseract
OCR and prefer up to four pictures with little embedded text. When every picture
has dense text, use the least dense two; missing OCR falls back to source order.
This is a heuristic, not language translation or semantic/visual deduplication.
No generated product imagery or paid AI service is added. Social titles stop at
70 characters/word boundaries and copy uses at most two existing grounded benefits.
Approved TikTok payloads whose Shopify source revision is unchanged are preserved;
future drafts use the improved template and still require actual preview consent.
MARKETING_PUBLICATION_REPORT emits grouped statuses, safe error codes and validated
public permalinks at startup and every five minutes. Accepted/pending provider jobs
remain separate from published posts. Authenticated status also exposes these.
113/113 marketing tests passed, including actual FFmpeg/Tesseract image selection,
cache reuse, preserved TikTok consent, sanitized reports and existing quota guards.
Before deployment: main 3f0c36b7be13b850d97e7c98a9c5ef4652754920 is live on Railway
0a6d1ee2-8e71-4d02-8288-13f9ba1bf002 (SUCCESS). At 19:27 UTC Meta is waiting on
DAILY_TOTAL_LIMIT (six historical posts/uncertain attempts versus new total cap4).
Merchant read-only audit: Homestro.de account5447184929 has 50/50 items disapproved
for misrepresentation. Account-level CRITICAL issue also impacts FREE_LISTINGS.
This change does not remove Google suspension or prove a new TikTok publication.

Verified at 19:34 UTC: quality commit0ba2f786628fda2180270b43941d23555092aa2b
reached Railway SUCCESS, deploymentd98419dc-1ab0-4709-b306-1d778028ddd7.
Startup publication report: FB9published/103approved; IG9published/103approved;
Pinterest2published/109approved; TikTok1published/104approved/6drafts. No active
social error codes were present. Last TikTok publication recorded19:10UTC:
https://www.tiktok.com/@homestroo/video/7695118040219782433
Last Pinterest publication recorded18:53:45UTC:
https://www.pinterest.com/pin/1094585884467476768/
These are provider-confirmed DB records; search retrieval could not independently
open those posts. Reports do not prove the new photo/template already appeared.
Shopify analytics for homestro_pilot UTM campaign, last7days:52sessions (IG47,FB5).
Sessions may include testing/owner traffic; not proof of unique customers or sales.
Review UI now displays confirmed publication links separately from approvals and
pending results, without taking approval/publishing actions on page load.
114/114 tests pass including generated UI harness for that distinction.


## Google Merchant repair — 2026-10-10
Live account 5447184929 still has the CRITICAL Misrepresentation account issue; all 50 loaded products are disapproved. Current Shopify delivery pages already describe Germany and Austria correctly; cached search excerpts were stale. Existing 30-day return page gid://shopify/Page/700011872638 (ruckgaberecht) was unpublished while the shipping/FAQ/terms/withdrawal pages linked to it. Published the existing page without changing its policy text; independent rendered audit now returns HTTP 200 and canonical https://homestro.de/pages/ruckgaberecht.
Legacy Google organic feed incorrectly charged DE EUR6.99 for every item even when one item costs EUR50 or more and qualifies for the advertised free shipping. Corrected the per-item DE shipping cost to EUR0.00 at >=EUR50, preserving EUR6.99 below and Austria EUR14.99. Regression covers EUR49.99, EUR50 and EUR79.99 and unchanged product prices. No brand or identifier claims were invented. Opera was not connected during the audit; no Merchant review has been submitted and no Google approval is claimed. Ad spend remains EUR0.

## Systemische provozní kontrola — 11. 10. 2026
Uživatel výslovně požádal odstranit opakované jednotlivé opravy a zavést spolehlivější způsob práce. Aktuální produkční služba je `homestro-ai-api-fixed-current` (Railway service `3ee64de3-7855-4b84-a866-43cc79bc56d1`), deployment `5a860d27-582f-43b0-b6bf-29e062987706` SUCCESS z 10. 10. 2026 19:54 UTC, databáze a persistentní volume `/data` jsou připojené. Při synchronizaci 11. 10. byly hlášené neplatné OpenAI přihlašovací údaje HTTP 401. Kódová oprava může zabránit opakovanému volání na každý produkt; automatický překlad cizojazyčného textu zůstane vypnutý, dokud není platný provider, nebo připravený německý text. Žádný klíč není uložen v repozitáři.

Ve stejné Railway produkci zůstává živá stará služba `homestro-ai-api` (`76327e58-ffdc-413e-ae30-434e5d3ed5e6`). Nemá `DATABASE_URL`; loguje `organic-pilot-v2 enabled=false, DATABASE_URL_MISSING` a Shopify autopilot selhává každých šest hodin s `Shopify is not configured.`. Její API doména však dostala několik požadavků z prohlížeče 10. 10., takže ji nelze vypnout jen na základě tohoto auditu. Starší a současný endpoint proto musí být při ověřování jasně rozlišovány.

Před tímto auditem chyběl GitHub Actions workflow a produkční konfigurace Railway uvádí `checkSuites=false`. Docker build kontroluje pouze kvalitu opravy, syntax `server.js` a `autopilot-core.js`; nespouští úplnou hlavní regresní ani marketingovou sadu. V PR 80 je proto nově workflow `.github/workflows/verify.yml`, který spustí `npm test`, `npm run test:marketing` a sestaví `Dockerfile.homestro-fixed`. První úplné spuštění odhalilo 6 selhání v existující hlavní sadě: krátký AI popis se odfiltroval před cílenou opravou, testovací console stub postrádal warn, produktový QA fixture nesplňoval nová pravidla SEO/alt textu a test autopilota hledal zastaralou signaturu funkce. Opravy jsou v PR 80. Následná kompletní CI kontrola na commitu `4bf7f02818715b97cf002b5bf6c18b76e832d24b` prošla: hlavní sada 91/91, marketingová sada 115/115 a sestavení produkčního Docker image. PR zůstává draft a změna nebyla nasazena do produkce. Railway konektor nemá operaci pro zápis `checkSuites`; dokud nebude kontrola v Railway nebo v pravidlech větve povinná, GitHub zelený status sám o sobě automatickému deploymentu nezabrání.

Bezpečnostní blokace zůstávají záměrné: nepublikovat neaktivní produkt či produkt bez veřejné nákupní URL; nepřekračovat schválené rolling limity; nejisté vzdálené publikace ručně ověřit, nikdy slepě opakovat. K 11. 10. bylo šest publikovaných/nejasných pokusů v posledních 24 hodinách při celkovém limitu 4, proto worker správně čekal na uvolnění limitu. Tento audit neprokazuje novou publikaci ani opravu Merchant Center.


## TikTok repair verification — 11 October 2026

Merged PR #80 with the Pilot reliability and TikTok diagnostic fix. GitHub Actions run
38147318209 passed the API suite, Pilot suite and production Docker image build.
Railway deployment d5cadb7e-b3ca-446e-a514-ae8b3c17f72f reached SUCCESS at
2026-10-11 14:34 UTC. The opt-in startup check confirmed the connected TikTok
account @homestroo and Zernio dryRun returned canPublish=true for an existing
owner-approved carousel preview. The dryRun did not create a public post.
The earlier two TikTok rows remain recovery_required with the old generic
ZERNIO_REQUEST_FAILED code; they were not resent because their remote outcome is
not confirmed. New Zernio failures now log only a safe operation label and HTTP
status, and the next opt-in check can isolate TikTok preflight failures.
