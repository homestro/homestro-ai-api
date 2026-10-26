Warning: truncated output (original token count: 32030)
Total output lines: 663

Warning: truncated output (original token count: 13966)
Total output lines: 411

## Meta Ads status update — 18 October 2026

Railway's read-only Meta preflight verified the active ad account and billing and
returned `pixel_access_verified=true` for Pixel `432750866484297`. No Meta Business
Manager Pixel permission change is currently indicated. A previous campaign attempt
failed with an HTTP status error; the publisher now records only the safe HTTP status,
request stage, and Meta error code/subcode so the cause can be diagnosed without
logging tokens or response bodies.

Commit `f6c36c74eee3823828c7bfaa4d8977d3cb06f85d` changes the one-shot Germany test
campaign from €5/day (€35 nominal over seven days) to a €5 lifetime budget over seven
days. Railway production deployment `3c371e1a-5be8-40e8-9fe7-59eaac8f777d` is SUCCESS
and online. `ALLOW_MICRO_BUDGET` is enabled for the requested test; a campaign or
delivery has not yet been confirmed. The previous publisher error left a single-use claim without a returned campaign ID.
The new publisher performs a read-only exact-name campaign lookup and releases that
claim only if Meta confirms no such campaign exists. If a campaign is found or Meta's
lookup is incomplete, it keeps the claim and blocks another creation. No campaign or
delivery is yet confirmed.

The scheduler's `NO_VERIFIED_CHANNEL_METRICS_LOADER` status applies to the separate
campaign-optimization path, which remains read-only. The campaign creation path uses
its own one-campaign, €5 lifetime-budget gate. Do not report a paid campaign as live
until Meta's campaign state and review status are verified.

## Organic publication blockers — 13 October 2026

Owner requests repairs that bring real shop traffic and sales, with paid ads at EUR0.
Source audit at commit 26fb7e53874d09d85c4c1d39ef24cba5120fd4e9 found three concrete blockers:
Pinterest's compiled productURL was a Railway click redirect but Zernio's strict destination
validation accepts only https://homestro.de. Six historical Pinterest jobs had
INVALID_PRODUCT_URL. Old recovery_required TikTok/Pinterest rows consumed the daily
quota indefinitely. Optional AI Reels failures (voice quota/auth/provider rate limits)
stopped otherwise usable photo posts during ingestion.

The repair uses a direct Shopify product destination with Pinterest UTM attribution,
counts social attempts/publications in a rolling 24-hour window, and falls back to
existing photo/video media when optional narration is unavailable. Voice budgets and
provider backoff are preserved. TikTok preview consent and Reels review remain required.
Only Pinterest INVALID_PRODUCT_URL recovery rows with exactly empty remote state are
retired as rejected local failures; provider intent, remote IDs and uncertain submissions
are retained and never blindly resent. Same-product duplicate guards remain timeless.

Local validation: complete marketing suite 151/151 passed, including real FFmpeg voice,
captions, carousel and OCR integration tests. This note describes the prepared code;
it does not yet prove a new live publication or an order.

Live storage configuration was separately corrected to PILOT_DATA_DIR=/data/marketing,
on the existing /data persistent volume. Railway deployment
37df9392-95e9-4cb3-8b13-5d7846f454dd reached SUCCESS. The enabled marketing runtime was
confirmed at 20:13:45 UTC. Existing channel counts and queued drafts are not proof of
new publication. The user's Shopify report for Oct 9–13 had 57 US bot sessions and
7 sessions from 3 German human visitors; do not describe bot visits as customers.

## MS Handwerk Meta + Google organic publishing — 11 October 2026

The implementation is prepared in PR #83 on branch codex/ms-google-auto-publishing-20261011. MS Handwerk has a separate Meta OAuth connection and encrypted account record; Homestro's Meta page and Instagram credentials are never reused. It adds Facebook and Instagram queues plus the existing separate Google Business Profile queue. Each platform is disabled by default and uses a maximum of one post per channel in a rolling 24-hour window. Paid advertising stays disabled at 0 EUR.

A manager must connect MS's own Meta page and Google profile once. The Pilot can then publish queued posts without an open chat. It does not invent customer jobs: a real completed-job description is supplied for each post. Instagram additionally requires a real public image hosted on ms-handwerkservice.de. Ambiguous outcomes are held for recovery and never blindly resent. Current Railway production lacks the new Google and MS Meta OAuth environment variables; these changes are not deployed or connected yet. No live post is claimed.

Local validation: Google, Meta and MS draft test suites pass; JavaScript syntax checks pass. Google API access and verified active profile requirements, Meta OAuth app review/permissions if required, and owner consent must be completed before live posting. See docs/ms-google-business-setup.md and docs/ms-meta-business-setup.md.

---\n\n## MS Handwerk Google Business automation — 11 October 2026

Implementation is prepared on branch `codex/ms-google-auto-publishing-20261011` in the GitHub pull request. It adds a separate Google Business Profile OAuth connector for MS Handwerk & Service, encrypted persisted credentials, an owner-authorized profile picker restricted to the exact MS Handwerk & Service profile name, a durable post queue, and a 60-second worker. The publisher is gated off unless Google OAuth settings and `GOOGLE_BUSINESS_AUTOPUBLISH_ENABLED=true` are present. The default cap is one post in a rolling 24-hour window. Posts use only supplied completed-job details; the generic template no longer promises unverified prices, availability or free inspections. Google posts are not sent to Homestro or Meta.

The worker records Google’s returned post ID and only marks a post published when its state is LIVE. A missing/ambiguous remote outcome remains held for recovery and is not sent again automatically. The owner can connect Google, choose the MS profile and enter completed-job details at `/ms-handwerk-google-connect`. The worker can publish queued content without a chat session, but it does not invent new customer jobs or details. Organic only; adSpendEUR remains 0.

Local validation: 6 Google publishing tests and 5 MS Handwerk organic draft tests pass; JavaScript syntax check passes. Current Railway production service `homestro-ai-api-fixed-current` is deployment `5944860d-6b1b-4b25-9ccd-db3b5ecb4539` SUCCESS. Its live variable-name inventory has no `GOOGLE_BUSINESS_*` settings, and this implementation is not yet deployed or connected to a Google account. No Google post is claimed. Google API access approval, OAuth client configuration and account-owner consent remain required before the Google feature can publish; Google requires the applicant to manage a verified Business Profile active for 60+ days and have the business website listed on the profile.

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
- PostgreSQL: šifrované přístupy podle značky a …1966 tokens truncated…H_AROUND_CLOCK configuration, persisted
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


## Homestro AI product Reels — 12 October 2026

An opt-in renderer is prepared on branch `codex/homestro-ai-reels-voiceover-20261011`. It uses an existing Shopify product MP4 where available; otherwise it adds a slow FFmpeg camera move to the product's first ready photo. It generates a factual German script from localized Shopify copy, requests a German voiceover from OpenAI, burns timed captions into a 720×1280 MP4, and reuses cached outputs. It does not regenerate product appearance or claim unsupported product benefits. The feature is disabled unless `PILOT_AI_VIDEO_ENABLED=true`, with limits of two new voice assets per UTC day and 20 seconds by default. Existing paid ads remain at 0 EUR.

The implementation and integration tests are on the branch for CI review; they are not deployed and no post is claimed. The last production operating note recorded OpenAI HTTP 401, so voiceover cannot be confirmed until the Railway `OPENAI_API_KEY` is replaced with a valid project key. Keep the feature disabled until that key works and rights to the shop's source media are confirmed. Local child-process execution is blocked in this shell. GitHub Actions verify run #202 passed API/regression tests, marketing pilot tests (including FFmpeg rendering), and the production Docker image build on 12 October 2026.

## Combined organic marketing — 13 October 2026

PR89 is live on commit c061d64e1398a9b7c744ea3a7bd32fcf6d9a95d7, Railway deployment 74ab7622-17f2-4868-9892-77faad7121ff. Catalog scan at 20:39 UTC processed 192 products with zero errors: ready products increased from 14 to 125 and current pending products fell from 190 to 79. Optional OpenAI narration limits no longer block ordinary image/video marketing. Pinterest links now use direct Shopify UTM destinations; six definite local invalid-URL failures with no remote attempt were retired. TikTok remote-uncertain rows remain blocked and were not replayed. Media assets persist under /data/marketing. These are readiness repairs, not proof of new publications or orders.

The combined implementation adds five useful German buying-guide topics with actual reviewed in-stock product links, stable Shopify Page handles, ownership fingerprints, immediate product freshness checks and an append-only daily write ledger. SEO publication is opt-in and defaults to one page write per 24 hours. It preserves merchant changes and uncertain remote outcomes. It pauses owned guides if fewer than three eligible products remain. No city doorway pages, invented reviews/specifications, paid campaigns, or instant Google indexation are used.

Private performance reports use read_reports and ShopifyQL to collect human sessions, carts, checkout sessions, orders and total shop revenue; shop orders are explicitly not Pilot-attributed sales. Missing access and provider failure appear as unavailable measurements, never invented zeroes. The raw Admin API returns keyed row objects; both real object rows and array rows are tested. Public dashboard combines confirmed Meta, TikTok and Pinterest publications and labels raw redirect counts as including preview bots. Financial measurements remain private.

The legacy Merchant feed URL can opt into the current verified Pilot feed engine, preserving the configured source URL while removing its old 50-offer limit. Both feed URLs recheck current Shopify price/stock and omit products whose freshness cannot be confirmed. Feed eligibility no longer depends on optional social-media rendering. Configured offer cap is 5000; rejected and excluded products are omitted. The Merchant Center misrepresentation account issue still requires Google approval; providing a valid feed does not establish approval or guaranteed free-listing traffic. Ads remain EUR0. Implementation tests and CI must pass before merge; record actual live deployment/publication separately.



## Combined marketing live verification — 13 October 2026

PR90 passed verify run229 and is live on commit 194476b1f49c1440d9b40441c4938a9829a08c40, Railway deployment ffd1af5b-99d2-4b34-8309-809afea75451. At21:26UTC Pilot confirmed its first six-product guide https://homestro.de/pages/homestro-ratgeber-kuechenhelfer; independent Admin read confirms published Page709701796222. Existing Merchant feed URL returned HTTP200 in13.3seconds at22:01UTC; public-results repeatedly returns HTTP200. This confirms backend outputs, not Google approval or new sales. Private measurement logs explicitly require read_reports. Confirmed totals remain Facebook14, Instagram14, Pinterest7, TikTok1; four uncertain TikTok outcomes remain isolated and were not replayed.

Live checks found Shopify inserts inter-tag HTML line breaks on Page writes, causing a false MANAGED_PAGE_CHANGED result. The original guide ownership SHA256 was recovered exactly by removing only inter-tag formatting whitespace and restoring the generator's article separators. The follow-up preserves the full title/text/attribute/link/marker fingerprint while accepting that formatting change; actual edits remain protected by regression. No existing page text is overwritten merely to recover ownership. SEO cadence remains one write per24hours, advertising EUR0.

## TikTok rejection investigation — 14 October 2026

Live report at08:31UTC c…12030 tokens truncated…nection returned authenticationrequired, no reauthorization requested and working runtime integration unchanged.

Added seo_writer.py to actual feed job: rotates across up to5feed variants per successful cycle, validates own active published product/variant URL and exact current name, generates only missing SEO title/description, preserves every existing nonempty field. Persists original values, proposed patch and source version before any mutation. Reads product twice before writing; concurrent changes hold. Shopify ProductUpdate has no atomic compare-and-swap, so a narrow race remains and no absolute concurrency guarantee is claimed. Only id/seo are sent: no product status, handle, body, inventory, price, theme or media writes. Existing token or appcredentials only, no resets/new keys.

Durable pending intent and confirmed/rejected/uncertain outcomes; lost response reconciles current fields on later scan and never blindly replays. Product-level dedup across variants/restarts. Successful provider write requires independent readback; merely healthy service or queued draft cannot be called published.60second total SEO cycle bound, pending rows retained on cancellation. Exposed through existing protected /pilot/brain as seo_publication. Existing watchdog/spend limits unchanged.139tests/Ruff/mypy pass. Schema discovery and connector validation performed for ProductUpdateInput/SEOInput/read queries. Runtime deployment and actual write evidence remain to be observed separately. GEO theme integration cannot be declared published: current MAIN theme writes/publishing are blocked by Shopify connector policy; no bypass attempted.

SEO deployment40a7908f6aff91db1637def9102434dacb715f9a /a2233e70-b67a-4eea-bca9-8dc2978fa68e SUCCESS observed. Actual12:37:56UTC writer checked5variantrows/3distinctproducts and preserved all existingSEO;0confirmedwrites. Working runtime credentials verified by actual operations, not reset. Actual earlier Insights0.35EUR/26impressions/0clicks/0purchases; learning hold MINIMUM_24H_EXPERIMENT, no new ad.

GEO concrete draft prepared through allowed Shopify connector mutations: duplicated current MAIN197365531006 into UNPUBLISHED198462833022 named Homestro SEO GEO preview 2026-10-25. Changed only layout/theme.liquid to add product-page-only native Shopify product|structured_data JSON-LD. Existing Tapita include remains: its inspected snippet renders metadata overrides, not a Product JSON-LD block. Mutation accepted with no userErrors; independent file readback matches exact proposed layout and exactlyone native structured_data block. No price/availability hardcoding: Shopify computes current product/ProductGroup offers. Added ProductGroup recognition to storefront diagnostics with regression test (140totalpass). Original and proposed layouts saved under homestro-marketing-pilot/theme-patches/20261025. Live theme still unchanged; connector forbids MAIN writes/theme publishing. Preview rendered-output fetch unavailable, therefore no live/rendered/schema-validator/indexing success claimed. Owner must publish prepared theme in Shopify Admin; do not bypass connector policy through other credentials.

## Persistent marketing director and existing media intake — 25 October 2026

Owner requests all four marketing-tool families and continued execution. Inspected existing organic JavaScript consumers first: reviewed organic posting, social queues, SEO guides and article draft/revision logic already exist; do not recreate them or claim their absence based only on isolated Python service. HYPD init reports trial ended; Google/Microsoft account list calls both return no accessible accounts. No paid account/channel or subscription enabled, no working Meta/Shopify credentials changed.

Added MarketingDirector persistent semantic-revision work queue in existing auditSQLite. Grounded campaign packs cover existing Meta experiment handoff, German social text, SEO/GEO, escaped landing drafts, recipient-free three-stage email drafts, and Google/Bing search proposals with zero extra budget and explicitly unknown demand. Dedup by canonical product path/kind/revision across variants/restarts; cost observation timestamps alone cannot recreate drafts; changed/unavailable products supersede prior proposals. Seven-day calendar uses Europe/Berlin. Existing durable campaign stop wins; no invented conversions, publication or free spending authority. Current external dispatch is NOT implemented for blocked proposal types: queue and managed-by-existing-consumer labels never establish that a specific task was consumed/published. Exposed through protected /pilot/marketing and /pilot/brain. No user-facing claim of full proprietary AI parity.

Organic bridge reads only existing Homestro main-service public-results endpoint, bounded1MiB/no redirects and report freshness checks. Separates publisher database receipt counts and published guide records from independently verified platform visibility. Reuses old publisher; never starts another social worker or submits duplicate posts. Optional observations do not fabricate profits or search rankings.

New read-only Higgsfield inspection found the11old completed AdsStudio runs are image outputs, not videos. Ordinary project asset inventory now exposes11completed image job IDs (earlier projects listing had no recentjobs; these are different APIs). Actual source/export URLs recovered from specific job read plus compact terminal-job snapshots, not regenerated. Exact product mapping confirmed only for jobe9ef0df6-9d35-4c40-ac10-051bd6f50667 -> existing travelneckpillow page via returned job params and existing AdsStudio product record. Other ten remain explicitly unmapped; do not infer mapping from list order/timestamps. Known old outputs registered in existing_media.py as nongenerative source manifest.

MediaRegistry now streams old files from exact observed CDN host, HTTPS/no credentials/query/redirect,100MiB bound, content SHA256, atomic persistent file storage and metadata verification. Images PILvalidated, videos require local ffprobe with file-only protocols,10second bound and size/duration limits (Docker installsffmpeg). Job/content dedup, missing-file restoration from SAME source, different bytes under old job rejected. Completed status required. Real files enter a review queue, unmapped outputs remain blocked; no visual approval, ad attachment, social publication, video generation or new subscription occurs. Protected /pilot/media and brain report separate stored files and publicationfalse. Import in creative consumer bounded90seconds, retains safe completed progress across cancellation; existing independent watchdog remains.161tests/RuffE,F,I/mypy pass. Deployment/import/provider readback still required.

Remaining actual integrations still block full four-service replacement: Google/Bing live runtime adapters/accounts, external trend-source authorization, recipient consent/suppression and email delivery, reviewed brand-knowledge generative strategy, exact media-to-product review and organic-publisher media handoff, GEO theme publication/rendered readback and actual complete contribution data. No claim these missing consumers are implemented just because strategy drafts now exist.

Director deployment720c315c8c3638c3411feb74de59951e52d594bb /c8861cba-342e-417f-8528-ccbdde9906d3 started and actual13:32UTC runtime recorded63persistent proposals from29eligiblevariants/9distinctproducts (54blocked proposals,9existing Meta-consumer-owned; these are not63executed actions). Organic bridge observed87published database records/7days (FB14,IG14,TikTok21,Pinterest38) and3existing published guide records at homestro.de/pages/homestro-ratgeber-haustierpflege, /homestro-ratgeber-ordnung-zuhause and /homestro-ratgeber-kuechenhelfer. Counts are publisher receipts, not independently measured reach or new publications caused by this patch.

Actual media importer13:32:26UTC confirms11existing images downloaded/verified/stored on persistent volume,0videos,0remainingimports, roughly55MBtotal. Initial deployment has1matchedreviewrequired/10mappingrequired. Then inspected all11EXACT original jobs in ONE existing-generation gallery (no new generation): each returns params.product_id. Joined those exact IDs to actual AdsStudio product.page_url records; all11manifest mappings are now known without time/order guessing. Added safe metadata reconciliation for existing downloads: fill previously unknown source mapping, forbid changing an existing job to a different product, recompute matches against currentfeed without redownload/regeneration. Still no automatic visual approval, ad replacement or claimed publication. New regression test verifies adding exact mapping without network download.162tests pass. Follow-up mapping deployment/readback still required.

## Read-only search channels, consent-aware email backend and bounded cognitive proposals — 25 October 2026

Mapping follow-up23fd63ab3217cefaf8bbc3488cd7a973ca6a4fd3 /f286e6ab-06c4-44d3-97d1-be913e6535ab reachedSUCCESS.13:47and13:52UTC import cycles report stored11/remaining0/results[] (no new downloads). Exact job/product mappings now reconcile existing files in place; detailed matched counts added for subsequent runtime evidence. Files are in review, not automatically published.

Added official GoogleAds RESTv26 read adapter (OAuth refresh or existing access token; customer identity/currency/timezone and LAST_7_DAYS reporting) and MicrosoftAds v13 REST campaign inventory reader. They call ONLY query endpoints, never create/update budgets, ads or campaigns. Missing runtime settings return explicit not_configured without requests; access failure is not proof of an empty successful account. Google's general conversions are not mislabeled Purchase; Microsoft inventory supplies no fabricated ROAS/performance. Integrated into common strategy evidence and protected brain report. Direct Microsoft access token has no implemented renewal; no claim of permanent connection. Full Google/Bing campaign write/optimization adapters still incomplete and additional channel spend remains unauthorized. Official refs: https://developers.google.com/google-ads/api/rest/examples and https://learn.microsoft.com/en-us/advertising/campaign-management-service/getcampaignsbyaccountid?view=bingads-13 .

EmailDelivery implements consent/suppression ledger, actual timestamped opt-in evidence, monotonic event ordering, signed POST unsubscribe with safe GET confirmation, explicit per-message owner authorization and independent default-off sendflag. SMTP_SSL465 only; requires configured sender/host and explicit daily cap1..100, at most1message/recipient/Berlin day. Address hashed with domain-separated existing admin secret; no plaintext address/body persisted. Durable reservation before SMTP; accepted means SMTP acceptance only, not final delivery/purchase. Lost response remains uncertain and cannot be replayed after restart. Rechecks suppression before send. Protected /pilot/email/consent and /pilot/email/send endpoints; no recipient data imported, SMTP configured or message sent during this task. Tests use .test domains and in-memory fakeSMTP only. Customer consent ingestion/provider domain deliverability and live delivery remain unverified.

CognitiveStrategy adds optional structured model proposals bound to validated catalog IDs/controller references and at most3editorial hypotheses. Model may reorder editorial proposal priorities; cannot change paid budgets/status, bypass source validation or auto-publish. Existing deterministic controller remains actual active brain. Uses existing OpenAI adapter with additive optional max_output_tokens1500, maxrequestbytes24000 and explicit standard service tier; defaults preserve old working calls. Exact modelgpt-6-luna, no expensive automatic fallback. At most1reserved call/Berlin day across restarts, including uncertain failures, with12000byte context bound and evidence-ID validation. NO real model call made: PILOT_REASONING_ENABLED and PILOT_REASONING_COST_APPROVED must both explicitlytrue; neither enabled. Current official standard pricing0.10USD/1Minput and0.50USD/1Moutput supports conservative estimated bound under0.01USD/day for this request ceiling, before any future price changes; this is software quote, not a provider account-wide billing cap. Existing image/video generation remains disabled. Official pricing https://developers.openai.com/api/docs/pricing inspected25October2026. Owner requires price approval before paid generation; ask before enabling this bounded optional step, never silently switch it on.

178tests/RuffE,F,I/mypy pass, including new fakeSMTP consent/optout/lostresponse/dedup/frequency tests, read-only provider HTTP shapes, model evidence rejection, one-call/day persistence, no-network disabled mode, request bounds and protected/public unsubscribe API behavior. New deployment/readback still pending. This advances code, not a claim of complete Tanganica/Christiani/Expoya/Crush parity; remaining integrations retain explicit blockers.

Final runtime readback for this implementation: commit9e2889474565368345546c720db06bc708cad76c deployedSUCCESS asb550fdf6-f6b0-4855-b790-086d363fc413. Actual13:55:30UTC reports11stored/11available/11matchedassets/0mappingrequired/0remainingimports/generationfalse. Director has63persistent proposals,54blocked/9ownedbyexistingMeta consumer; no claim all tasks executed. Organic receipt bridge still87publishedrecords7d. Cognitive state DISABLED/PAID_REASONING_REQUIRES_OWNER_COST_APPROVAL, deterministic controller active,0newmodelcalls. Google and Microsoft adapters both NOT_CONFIGURED using runtime evidence; no credentials reset. Email flag remains defaultoff, no recipients imported/no liveSMTPcalls. Existing campaign120254444566440274 watchdog active_confirmed at13:55:10UTC with5EURdailycap and0freshsignedpayments; active confirmation is not Purchase verification.178tests passed. Full four-vendor parity remains incomplete; do not hide missing Google/Bing write adapters, media publication consumer/visual approval, account connections or GEO theme activation behind this successful deployment.


## Existing-media native publisher handoff and non-spending search preparation — 25 October 2026

Current owner instruction restores the strict Purchase measurement lock, overriding the earlier bounded-test waiver. Railway variables now PILOT_LAUNCH_POLICY=prove_it_first and PILOT_ACCEPT_UNVERIFIED_MEASUREMENT=false. Deployment33da4401-ffab-4878-b2af-ce47371d0ae2 SUCCESS; watchdog independently confirmed campaign120254444566440274 PAUSED at16:28:24 and16:29:34UTC. Daily5EUR/seven-day/35EUR limits were not increased; no new campaign/ad set/ad created. Credentials and integrations were not reset.

Native receiver main commit9aa5895b61a213211b5c696d039eb8beec3d7e39 deployedSUCCESS c12ae2fd-a842-4233-a538-e2e0f09807e5. Authenticated raw binary import binds provider job, SHA256 and exact existing product URL; refreshes current product revision and preserves reviewed localized facts, stages source and normalized media on the existing persistent volume. Transactional inserts populate existing marketing_posts/marketing_social_posts in draft_queued, with exact hash/revision-bound visual review. Native automatic approvals and supersession exclude these imports; TikTok retains independent preview/express consent/privacy gate. Original bytes and normalized hash are rechecked before approved publication; corruption/source changes hold publication. No paid generation, new products, new videos or automatic approval.

AdTech sender commit90d9c351e385f2af5c82fbbcbaabeb5910c3b6c8 deployedSUCCESS fe264a14-feac-4349-a3b3-c9454c5533c2. Internal authentication references the publisher existing HOMESTRO_API_KEY through Railway reference syntax; no credential value is stored in code/chat. Persistent transfer receipts and GET-before-upload reconcile lost responses without duplicate queue entries.16:35:17UTC independent authenticated publisher readback confirmed11/11assets and44native queue rows:11each Facebook/Instagram/TikTok/Pinterest, all draft_queued/requires_visual_review=true,0published,0blocked/unconfirmed. These are existing images, not videos. Queue receipt is not approval, schedule or platform publication.

Added SearchCampaignDrafts: stable per-product-path/channel identities, source revision fingerprint, six-hour expiry, variant deduplication, deletion of disappeared/ineligible products, German grounded headline/description sets and exact/phrase keyword hypotheses. Protected report/compile endpoints cannot activate ads. Google compiler emits PAUSED campaign/adgroup/ad/keyword dependent operations with validateOnly=true and partialFailure=false; optional default-off provider validation resolves actual DE/AT countries and German language and checks EUR/account identity. Provider validator tested with fake transport ONLY; no actual Google validation call/account connection asserted. Bing emits explicitly offline PAUSED Campaign/AdGroup/ResponsiveSearchAd/Keyword request templates with unresolved IDs/geo dependencies; NO production write transport, approval or live campaign. Proposed5EUR budget is schema-fixture input only, authorized new channel spend remains0EUR. Native German copy/name review, keyword demand, actual account connection, Purchase measurement and new channel spend authorization remain blockers.

Validation after integration:191Python tests,219Node tests, RuffE/F/I and mypy64files pass. Additional coverage verifies loss/restart reconciliation, strict receipt identity, authenticated endpoint access, actual media corruption holds, draft/approval/publication distinction, paused provider payloads, immutable validateOnly, expiry, revision change, unsafe targets/copy/budget rejection and zero-network unconfigured mode. Optional paid cognitive reasoning and generation remain disabled. This does not establish complete Tanganica/Christiani/Expoya/Crush parity. Search preparation follow-up deployment/readback pending at the time of this note.

Official schema references inspected25October2026: https://developers.google.com/google-ads/api/reference/rpc/v26/MutateGoogleAdsRequest ; https://developers.google.com/google-ads/api/samples/add-campaigns ; https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigns?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/campaign-management-service/responsivesearchad?view=bingads-13 .


Follow-up: separated unpaid draft preparation, organic evidence, existing-media handoff and search planning from Meta paid control gates. A stopped test, disabled paid publishing or stale/unavailable Meta metrics no longer suppresses those unpaid consumers. Current Shopify feed evidence remains mandatory; successful feed recovery schedules preparation immediately. Meta reconciliation/publishing still runs only after the existing paid gate; no new bypass, approval, generation or spend. Two added dispatch tests plus full193Python tests/Ruff/mypy pass;219Node tests pass. Search follow-up1d36e6a/4b2fad7e and receiver test follow-up70116c3/e9cabcbe bothSUCCESS. This refactor follow-up deployment/readback pending.


## Channel-isolated attribution — 25 October 2026
Continued from deployed publisher 70116c3 and adtech 902f9c6. Added a channel binding to signed attribution links and persisted order economics, preserving legacy Meta signatures and migrating existing orders to channel=meta. Google/Microsoft and social channels cannot credit Meta through colliding campaign IDs. Signed Shopify payment webhooks remain the purchase source; ordinary UTM parameters are insufficient. Order hashes remain globally unique, refunds invalidate the same row, missing channel spend remains unknown rather than zero. This is tagged landing observation, not causal attribution or platform conversion-upload verification.

Authenticated endpoints: POST /pilot/attribution/link, GET /pilot/attribution and GET /pilot/search/readiness. Link issuance does not publish, verify campaign ownership, create campaigns or authorize spend. Production Railway variable-name inventory on homestro-adtech-pilot contains GMC credentials but none of the GOOGLE_ADS_* or MICROSOFT_ADS_* credentials. Google requires GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_DEVELOPER_TOKEN and either GOOGLE_ADS_ACCESS_TOKEN or the CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN trio. Microsoft currently requires MICROSOFT_ADS_ACCOUNT_ID, MICROSOFT_ADS_CUSTOMER_ID, MICROSOFT_ADS_DEVELOPER_TOKEN and MICROSOFT_ADS_ACCESS_TOKEN. Secrets belong in Railway, never chat or git. Existing Shopify and Meta connections are preserved.

Validation: 197 Python tests passed, including old-schema migration, old signature compatibility, cross-channel campaign-ID collision, duplicate payment, refund, source tampering and authenticated link routing. No AI generation or ad campaign write was performed. Google live campaign mutation/optimization, Microsoft live campaign mutation/performance optimization, automatic channel-link adoption by publishers and GEO theme activation/readback remain incomplete. Do not describe full four-platform feature parity as complete.


## Organic signed attribution adoption and stop-only channel control — 25 October 2026
Publisher redirect destinations now mint channel-bound signed purchase references at click time using the existing internal publisher key. Pinterest signs only its outbound productURL at actual submission, preserving draft/review hashes and the strict shop destination. TikTok preview consent is unchanged. Adtech payment receiver accepts that existing publisher key only for facebook/instagram/tiktok/pinterest, never paid Meta/Google/Microsoft. Seven-day expiry, signature verification, paid-order HMAC verification, order deduplication and refunds still apply. No historical attribution or actual sale is claimed. Node-to-Python signature compatibility was executed with a synthetic test vector.

Added common-budget allocation proposal code with a single maximum EUR5 global daily cap, exact-cent validation, Purchase hard lock and required fresh common-window signed-order/cost evidence. No proposal grants spend. Runtime records zero allocation because additional channel spend is not authorized. Added official Google status-only POST and Microsoft status-only PUT pause transports with configured-account checks, default-off PILOT_SEARCH_STOP_WRITES_ENABLED, bounded responses, safe errors and independent inventory readback. Authenticated POST /pilot/search/{channel}/{campaign_id}/pause first verifies actual campaign/account inventory, records intent, then performs only PAUSE; never creates/enables/budgets a campaign. Unknown/lost/partial replies are unconfirmed, not success. This is protective stop control, not a complete Google/Bing campaign creation/optimization engine.

Shopify live read confirmed MAIN197365531006 and existing UNPUBLISHED198462833022 (Homestro SEO GEO preview 2026-10-25). No new theme/product/asset was created. GEO activation remains a theme publication requirement; previous connector MAIN-write/publish restriction is not bypassed. Google/Bing campaign-creation writers, complete Microsoft performance reporting, automatic live budget reallocation and full conversion-upload verification remain incomplete; external account credentials and explicit channel-spend authorization also remain absent. Paid model reasoning/generation and SMTP remain disabled. No four-vendor parity claim.

Validation:203Python tests,221Node marketing tests; Ruff and mypy66source files. Deployment readback is recorded separately after shipping.


## Search write transports and durable Microsoft reporting — 25 October 2026
Continued from production be88711/adtech and d5c51b8/publisher, both previously observed SUCCESS. Added default-off GooglePausedWriter: current draft/revision review, provider validateOnly first with actual EUR/account/DE/AT/language lookup, exact-name duplicate check, atomic paused resource bundle, durable intent before mutation, independent campaign PAUSED readback. Existing or uncertain intents never replay creation. Authenticated POST /pilot/search/drafts/{id}/create-google-paused requires a current unexpired draft and reviewed exact revision. GOOGLE_ADS_PAUSED_CREATION_AUTHORIZED and existing GOOGLE_ADS_VALIDATE_ONLY_ENABLED are required; neither enabled here. No active campaign, spend or full ad delivery claim.

MicrosoftPausedWriter resolves dependent campaign/adgroup/ad/keyword IDs in four sequential official requests, each paused, with EUR/account metadata check, existing-name hold, per-operation durable intent, partial-response IDs retained, no blind recreation after restart/lost responses and independent campaign-state readback. Authenticated POST /pilot/search/drafts/{id}/create-microsoft-paused requires current draft/revision review and MICROSOFT_ADS_PAUSED_CREATION_AUTHORIZED=true; left disabled. These are paused draft objects only: Microsoft DE/AT location/presence criteria are still unverified/not attached, all activations remain blocked. No new objects were actually created.

MicrosoftReports implements official async report submission, later polling, bounded ZIP/CSV download/parser, account/currency/unique-campaign validation, missing optional conversion values retained as unknown, durable pending job and 30-minute observed-report cache. No credentials attached to report downloads; no redirect following; provider URLs restricted to approved Microsoft suffixes; temporary signed download URLs are not persisted. Empty provider results do not establish EUR/account purchases. Report windows remain provider-default and explicitly not reconciled to a cross-channel common attribution window. Actual returned conversions are not signed Shopify purchases. Existing five-minute unpaid cycle consumes this report without blocking paused Meta; protected GET /pilot/search/microsoft/performance also advances the read-only report state. Reports and paused creation receipts are included in /pilot/brain evidence.

Microsoft OAuth web credentials (MICROSOFT_ADS_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN) can now replace the optional manually supplied MICROSOFT_ADS_ACCESS_TOKEN. Refresh rotation/access expiry is cached and encrypted in the existing audit database using a key derived from the existing PILOT_ADMIN_KEY (or optional PILOT_ADS_TOKEN_ENCRYPTION_SECRET). Working direct-token integrations remain supported unchanged. Corrupt/changed encryption keys fail closed rather than clearing tokens. cryptography dependency added. No OAuth grant, new token or reset was requested/performed in production; account settings remain missing.

Validation:218full Python tests passed including the Microsoft lost-child-response regression; Ruff E/F/I and clean-cache mypy74files passed. Node remains previously verified222tests; Node source not changed by this continuation. New tests cover cached report restart/poll/download, foreign downloads, invalid currency/account/numbers, duplicate summaries, missing conversion values, encrypted rotated credentials, default-off writes, paused-only payloads, dependent IDs, lost/partial outcomes, stale review and authentication. Actual provider schema/live integration remains unverified without accounts. No ad activation, AI generation, new product/video, SMTP send or theme publication occurred.

Remaining implementation/live boundaries are explicit: no Google/Bing active-campaign enable/budget-change path, no attached Microsoft location/presence targeting, no full ad/keyword/geo readback, no verified cross-channel common-window cost allocation, no conversion-upload verification. GEO theme198462833022 and imported visual review remain pending owner/account actions. These changes do not establish complete four-vendor parity.

Official references checked this continuation: https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/reporting-service/pollgeneratereport?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/reporting-service/reportrequeststatus?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportrequest?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/customer-management-service/getaccount?view=bingads-13 ; https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-get-tokens?view=bingads-13 .


Packaging correction found before shipping: the prior explicit Docker COPY list omitted channel_control.py, although healthcheck SUCCESS did not execute that import. Changed module copying to the package's top-level *.py only (no tests), keeping the root entrypoint copy, so all runtime modules including new search/report/auth code are present. This repairs the missing-module failure in the unpaid job; healthy HTTP alone was insufficient evidence. Packaging/import smoke and live unpaid-cycle readback are required below.


## Observe whole-catalog preparation — 25 October 2026
Added a counts-only bridge to the existing main-service CatalogBrain through the existing PILOT_ORGANIC_API_KEY. It accepts only fresh generatedAt/boolean-enabled/known distinct work-state integer counts; limits response size, forbids redirects and exposes neither credentials nor source copy. Its report explicitly distinguishes catalog work-ledger evidence from platform publication. New organic_catalog_brain evidence is recorded by the unpaid marketing consumer and shown in /pilot/brain. No second publisher, new product/media, paid generation, campaign call or credential change. Missing/unavailable coordinator does not stop other unpaid consumers. User confirms no Google/Bing accounts yet while awaiting court verification; both remain unconfigured and paused creation/activation remains disabled. Validation220Python tests/Ruff/mypy74files; live main/adtech deployment readback remains required.


## Consumer-aware marketing director and paused Bing targeting — 25 October 2026
The director now consumes authenticated per-product publisher evidence bound to its exact source product/revision. Fresh native queue receipts advance social tasks to consumer_evidence_observed, without claiming new platform publication or equivalence to a potentially different XML feed revision. An outage retains the last receipt as explicitly historical while restoring the current blocker. Aggregate counts, stale evidence, another product and older native creative revisions do not resolve work. Google/Bing runtime adapters no longer falsely appear missing; actual observed account state and spend blockers are separate. Coverage is bounded to the publisher report's100products; unobserved records remain unconfirmed.

Microsoft paused creation now requires explicit exact DE/AT country location ID configuration (MICROSOFT_ADS_COUNTRY_LOCATION_IDS_JSON), adds both location criteria plus PeopleIn intent before child creation, persists every intent/returned ID, and independently reads campaign language/status, both geographic IDs, intent, German paused ad group and absence of overriding ad-group Location/Radius criteria. The ID-to-country mapping itself remains externally configured account setup data, not independently established by readback. targeting_verified staysfalse and country-mapping review/Purchase/spend blockers remain; no activation transport or authorization was introduced. Microsoft's documentation forbids deriving country identity from display names, so no guessed IDs or names are used. Official operation endpoints checked against Microsoft Learn CampaignManagement/v13 AddCampaignCriterions/GetCampaignCriterionsByIds/GetAdGroupsByIds/GetAdGroupCriterionsByIds docs. The owner has no Google/Bing accounts while awaiting court clearance; no new account or live Ads call was made. No credentials were reset.

Publisher follow-up also adds reviewed completed-motion download/cache/normalization and native draft handoff plus existing-task read-only polling; no funded generation was performed. Actual media handoff is independently evidenced by native queue rows; review_required and drafted remain distinct from publication. Tests include actual synthetic MP4 normalization into four native draft queues, not a claim of real product visual quality. Shipping/live verification follows.


## Final autonomous scan/recovery/accounting hardening — 25 October 2026
Fixed a concrete live Python SEO poison-row defect: daemon passed the whole parsed feed into the missing-only SEO writer; local product eligibility failures were treated as provider failures and broke before updating the persistent scan cursor. The writer now skips locally ineligible rows and unknown non-variant identities, advances the cursor, and reaches later valid rows after restart. Provider/network errors still stop the pass without moving past the failing request. Existing pending/uncertain SEO writes still only reconcile and never blindly retry. No Shopify token/schema or reviewed publisher SEO was replaced.

New scheduled SearchWriteRecovery observes up to20 persisted write intents/channel, rotates fairly after restart, verifies exact configured account/EUR and exact known campaign ID plus compiler-derived name, and stores separate timestamped readbacks. Original intents/steps/known IDs are untouched. A missing ID may produce only identity_unconfirmed name candidates; ambiguity/absence is not failure proof or permission to recreate. No intents means zero network. The implementation has only provider read endpoints, no campaign mutation/resume/budget operation. Campaign PAUSED proof explicitly does not establish a complete ad bundle, delivery or spend authority. Results are available in /pilot/brain via search_write_recovery.

The cross-channel allocator now receives actual normalized provider spend and signed-order/recorded-cost observations instead of an empty portfolio. The new common accounting uses one explicit half-open seven-day UTC window, excludes orders at its upper boundary, retains exact decimal contribution and validates freshness, EUR, unique campaign summaries, persisted ownership scope and complete costs. Existing lifetime/account-default-timezone reports remain explicitly unaligned: their spend can be observed, but unknown window/scope must not become verified profit or a winner. Reported provider conversions never replace signed orders. cross_channel_accounting exposes each blocker; the runtime common allocation cap stays0EUR with no writes/scale authorization. No claim that the current provider reports already establish common-window profit.

Validation:242Python tests passed, including poison-row restart progression/provider cursor retention, read-only search intent recovery with account/name/ID mismatch/ambiguity/rotation, and accounting boundaries/missing costs/staleness/duplicate metrics/no spend authority. Ruff and clean-cache mypy80source files passed. Previous publisher remainsbe2d934 with241Node tests, deploymentf77a9f45-1436-47d2-98d9-2f2a72c0c1f3 SUCCESS. Prior adtech720067f deployment4ab095a8-0622-4b1e-b1e7-9af7925dcb45 SUCCESS and live director changed7tasks to consumer_evidence_observed after receiving37 exact native-queue product snapshots. No new media generation, duplicate products, credential reset, paid activation, or Google/Bing account setup was performed. Shipping/live readback follows this hardening release.


## Whole-catalog receipt pagination completion — 25 October 2026
Authenticated publisher evidence is now cursor-paginated in stable product_id order,100rows/page. The bridge follows up to20pages/2000records, rejects repeated/disappearing cursors, changing global state counts, duplicated IDs and incomplete reported coverage; legacy responses remain explicitly coverage_complete=false. The director no longer truncates consumer evidence to the first100products. Planning/publication policies are unchanged. Local244Python tests,243Node tests, Ruff and mypy80source files passed. Prior hardeningf685f76 deployment7fd08142-cbf3-4e5f-99d8-40b1eb9c40bc SUCCESS; live SEO checked5, skipped2ineligible sources and preserved3existing SEO records, with no stuck ValueError. Scheduled search recovery reportedno_intents without calls. Accounting observed historical provider spend while common-window/cost proof remainedfalse and runtime spending authority0EUR. Final pagination release/live coverage readback follows.
## Brand evidence memory implementation — 26 October 2026

Prepared on the existing adtech source branch lineage, not yet deployed: persistent
Homestro-only versioned brand/story memory with authenticated GET/PUT
`/pilot/brand-memory`, optimistic revision checks and immutable revision history.
Entries require explicit review and a clean own-store source URL. Product claims
require exact product and source revision; generic strategy never receives those
claims without that binding. No brand story, customer review or product benefit
was invented or seeded. The deterministic director attaches the reviewed context
to existing campaign packs and supersedes old proposals when memory changes.
The existing optional cost-gated reasoning adapter receives cited brand evidence;
its paid enablement and once-per-day limit remain unchanged. Existing consumers
still require their own review and receipts; memory is not publication authority.

Validation: 249 Python tests passed (37 targeted); Ruff passed for changed source
and new test, mypy passed for four changed source modules, git diff check passed.
No live memory write, paid API call, product/video duplication, ad activation or
customer message occurred. Full four-vendor coverage is not established by this
increment. Current request also includes explaining subscription vs API billing
and the commercial limits of automation; no guaranteed sales claim is justified.

### Sales-goal and memory freshness follow-up — 26 October 2026
PR118 merged at281d020; Railway deploymentd2504fdf-1bce-44a2-a079-4aff057600d0
reachedSUCCESS. Runtime resumed feed/SEO/control cycles; existing media handoff
readback confirms11stored images,44queue rows and0confirmed published imported
assets. This is not new generation or a sale.

Follow-up implements the owner's existing target10paid orders/day and minimum
EUR10profit/order, with Europe/Berlin day boundaries including DST. Protected
GET /pilot/goals and the regular director cycle read the existing signed-order
ledger, exclude blocked/refunded/cancelled and future records, and distinguish
tagged orders from unknown total shop orders. Missing daily advertising costs
and complete net-profit accounting remain explicit; contribution is not labelled
net profit. Goal achievement grants no spend or campaign authority. Existing
paid reasoning cache now rejects changed brand/product context as stale without
making another paid call that day.254Python tests, Ruff and mypy84files passed.
Shipping and production goal readback follow; no paid activity is authorized.



## Channel accounting evidence isolation — 26 October 2026

Accounting now isolates malformed provider payloads to the affected channel instead of aborting the whole cross-channel evaluation. Owned campaign IDs must be a bounded, unique list of numeric strings, and every owned campaign must have an explicit spend row (including zero). Missing campaign spend cannot inflate contribution. Existing signed-order costs, exact common windows, Purchase hard lock, and zero additional spend authority remain unchanged.

Validation: 26 accounting, allocation, order economics and sales-goal tests passed locally. This code change does not supply missing fulfillment/payment/return costs or normalize provider reporting windows; those remain explicit evidence dependencies. No new campaign, generation or publication is claimed by this entry. Deployment readback is required separately.
