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

Live report at08:31UTC confirms new Facebook, Instagram and Pinterest posts at07:00–07:02UTC: https://www.facebook.com/122263627130172038/posts/122264714570172038, https://www.instagram.com/p/DedzN54GLyR/ and https://www.pinterest.com/pin/1094585884467764431/. TikTok remains one confirmed publication and now five recovery rows, including three POST_CREATE_HTTP_400 rejections. Preflight success is not live publication success.

The provider adapter previously discarded all HTTP400 details. The prepared repair emits only whitelisted error types/codes, bounded known field paths, numeric upstream codes and fixed diagnostic categories; raw messages/tokens/captions are never logged. Creator info now requests mediaType=photo for photos instead of silently checking the provider's default video limits. Sources: https://docs.zernio.com/platforms/tiktok and https://docs.zernio.com/guides/error-handling.

An explicit operator-only probe can examine one existing HTTP400 attempt before a fixed cutoff. It requires its original stored idempotency key, actual preview/consent, unchanged Shopify revision, current eligibility, publication window and daily limit. It reads provider posts first and reconciles any matching record. Only if no record is found may the exact same logical request be replayed with the exact original key inside a strict12h window (provider documents24h retention: https://docs.zernio.com/guides/idempotency). A DB advisory lock and durable per-job probe reservation prevent concurrent or repeated checks; future jobs after the fixed cutoff are excluded. Old uncertain outcomes are not replayed. The opt-in probe is disabled by default and must be turned off after the result is recorded. No quota/spacing reset, new job or paid advertising is created. Deployment and actual probe result are not claimed by this preparation note.

PR92 passed100 API and184 marketing tests and is live on commit942000cf1a376f3ec9baf760cd44050d02310792, deploymentd02360c1-e137-4954-b762-7b437775640a. The probe rechecked exactly the14October HTTP400 intent12e3a630-4f0c-4135-bc67-ff4378aa9c14 with its stored key and verified original account6aca3e759194b78f99c0f59d. At08:55UTC it again returned HTTP400 with no canonical type/code/param. No new publication was claimed. The durable probe guard prevents another replay of this intent.

The follow-up uses the documented POST/v1/tools/validate/post endpoint on that exact stored payload, without publishing, processing media, account writes or usage tracking. Nested legacy errors are reduced to fixed diagnostic vocabulary/categories; raw provider text remains private. OpenAPI source https://docs.zernio.com/api/openapi explicitly documents the non-publishing behavior and valid/errors/warnings response. This validation does not establish account-level eligibility or successful publication.

PR93 production validation at09:08UTC returned valid=false with fixed diagnostic words image/failed. This does not yet prove the root cause. The next repair checks approved local media before publication, restores missing photos only from the unchanged original Shopify source under the identical version1 cache key, and refuses replacement video or unknown photo sources. Validation runs after the public asset route is mounted. Approved payload and consent remain unchanged; no additional replay is enabled. Local marketing suite:189 passed.

PR94 and PR95 passed full CI and are live. At09:23UTC the pinned TikTok job restored four absent approved images without changing URLs/payload. Validation failed initially during rollout, then succeeded at09:29:13UTC with all ten originals present. Internal public HEAD probes timed out and do not establish external unavailability; provider validation succeeded. A separate explicit asset-repair probe is limited to this exact UUID and original account, requires the previous recovery marker plus fresh successful non-publishing media validation, and durably reserves assetRepairProbe before reading/replaying. The original key,12h bound, shared lock, consent and quotas remain enforced. No old uncertain intent is replayed. Publication is not yet claimed.

## New OpenAI project verification — 14 October 2026 afternoon

Owner replaced the Railway OpenAI key after finding the previous project had no credit. Deployment3a93825b-6bc0-45f9-95e4-8f4a18c33c1d reached SUCCESS. New startup reports AI_VIDEO_DAILY_LIMIT rather than the previous OPENAI_RATE_LIMIT, but completed video output is not yet claimed without its file. Add bounded AI_VIDEO_READY logs only after an MP4 exists/completes, exposing its existing public asset URL without secrets. An opt-in read-only Meta audience check reads account follower counts and latest confirmed post reactions/comments, preserving missing values as null. Reach/views and account restriction status remain explicitly unmeasured. Local marketing192 tests passed; no ad spending or TikTok consent change.

## Product-video visual repair — 14 October 2026

Owner rejected the initial image-zoom clip as poor quality. Replace its oversized SRT styling/cropped hero image with explicit720x1280 ASS typography, protected brand/header/caption/footer zones, whole-photo framing, three cuts with different camera scales, photo selection via existing cached OCR, supported-benefit scenes and a neutral shop CTA. Native Shopify videos keep their actual footage. Reuse original version2 script/speech caches for the new version3 visual layout, so rebuilding the two existing funded videos does not spend another voice allowance. Future script/TTS prompts start with a concrete grounded question and natural conversational German. New media URLs are distinct; historical TikTok preview/consent remains tied to its original payload and is never transferred silently.

Local193 tests passed, including real FFmpeg encoding and rendering again from the existing narration at a full daily voice cap with zero OpenAI calls. A temporary real-product brush preview was visually inspected: English source-copy-heavy image replaced by a cleaner actual usage photo, normal-size captions and German header/footer. This is source-photo animation with voice, not generated realistic product motion or proof of marketing reach. Deployment and public new clip must be verified separately.

## Actual generative motion requirement — 14 October 2026

Owner explicitly rejects photo animation and requests genuinely moving animated/realistic product-use scenes. The existing FFmpeg clip is not a generative-video implementation and is not a satisfactory final result. Prepared a separate Runway Gen4Turbo image-to-video draft adapter with authenticated start/poll endpoints, original-product reference checks, durable task/spending intent, no blind replay after lost responses, default disabled gate and estimated25UScent UTC-daily cap for one5second scene. Outputs remain review_required; no social post or testimonial is automatically made. This is an initial motion-scene integration, not a complete tested multi-shot ad engine. A stylized/realistic provider prompt cannot guarantee visual product fidelity and must be reviewed.

RUNWAY_API_KEY is absent in production (names-only inventory), while OPENAI_API_KEY exists. No Runway generation/payment/account creation was performed. Primary sources https://docs.dev.runwayml.com/guides/using-the-api/, https://docs.dev.runwayml.com/api/ and https://docs.dev.runwayml.com/guides/pricing/: gen4_turbo5credits/sec atUSD0.01/credit, five-second sceneUSD0.25 before applicable tax, additional attempts add cost. Model/API values verified: X-Runway-Version2024-11-06, duration5, ratio720:1280. Initial full local suite196passed; follow-up4adapter tests also pass, including completed outputs held for review. True generated-video quality cannot be validated without the separate funded provider key.


## Paid media planner foundation — 16 October 2026
A read-only readiness endpoint is prepared in draft PR #104: `GET /api/marketing/v2/ads/readiness`. It reports product candidate counts and blockers for Meta, Google, TikTok, Pinterest, Microsoft Ads and Sklik. It does not connect to ad platforms, create campaigns, change budgets or spend. Ad spend remains 0 EUR and campaign execution is disabled. Google Merchant Center approval is deliberately reported as unconfirmed because the latest verified audit records 50/50 items disapproved for misrepresentation and shipping configuration. Added unit tests cover spend guard, product eligibility and Merchant Center status. GitHub Actions verification is running; no local Codex development environment or production deployment is available for this change.


## All-products Meta catalog support — 24 October 2026

Prepared in branch `codex/meta-catalog-all-products-20261024`: the AdTech publisher now targets a configured Meta product catalog and product set, uses catalog item images and destinations, and no longer binds publication to `MICRO_BUDGET_PRODUCT_ID`. Live submission also requires `META_PURCHASE_EVENT_VERIFIED=true`; missing catalog, product-set, or Purchase verification blocks the publisher. The current Railway service has no configured catalog/product-set IDs, and Purchase-event verification has not been confirmed. This branch has not been deployed; ad spend remains €0. The operator must select/create a Meta product set that contains all intended validated-feed products and configure its IDs after the catalog/feed mapping is verified. No campaign was created or changed by this work.


## Production fix verified — 24 October 2026, 16:26 Berlin

PR #115 is merged into deploy/adtech-pilot (merge 7d461fda77b3f1d2b49cf0d9dfaebd8e5c491a06). Follow-up fixes retire the old campaign independently of paid gates, atomically archive its exact local claim with status INACTIVE, and report the outcome in the heartbeat. When Meta confirmed the parent PAUSED but children were ACTIVE, the targeted retirement idempotently paused those children and reread their state before archival. No activation or budget increase was performed.

Railway deployment ff92738b-99e5-4c02-ab79-f658c220313b is SUCCESS. The heartbeat generated at 14:26:42 UTC confirms retired_campaign.status=INACTIVE for campaign 120254321479480274, catalog mode with 384 validated feed items, and publisher blocked by META_PURCHASE_EVENT_NOT_VERIFIED. The separate optimizer still reports NO_VERIFIED_CHANNEL_METRICS_LOADER and READ_ONLY. Do not call the entire autonomous system complete or claim a new campaign/publication. Catalog-mode submission is implemented; actual Meta product-set membership and live delivery remain unverified behind the Purchase gate. No product or paid video generation was performed in this repair.

Local verification: 48 Python tests pass, Ruff passes, mypy passes across 20 source files. See docs/pilot-24x7-architecture.md for deployed architecture and explicit outstanding modules. Preserve all working Shopify/Meta/Railway connections. Next code work concerns actual performance loading and attributable Purchase/margin evidence; do not reset existing integrations or repeat this completed campaign retirement.


## Owner-confirmed Purchase and launch attempt — 24 October 2026, 16:51 Berlin

Owner explicitly confirmed that Purchase measurement works and ordered launch. Set META_PURCHASE_EVENT_VERIFIED=true in the existing AdTech production service; do not ask to repeat the event test. Deployment 9dc16714-997c-4997-b2c5-1a2eb37ddf24 reached SUCCESS. Its heartbeat confirms the publisher passed the Purchase gate but failed closed on the catalog/product-set read: HTTP400, Meta code100/subcode33, GraphMethodException for catalog1247298176307928 (unsupported GET / unavailable object / permissions). The existing Shopify screenshot establishes that catalog ID exists, so do not recreate the catalog. Resolve only the pilot token's catalog visibility/operation permission. No campaign claim was consumed and no campaign was created in this attempt. Optimizer still READ_ONLY with NO_VERIFIED_CHANNEL_METRICS_LOADER; working ad account/Page/pixel access remains confirmed. No new paid creative generation.

## Autonomous purchase watchdog repair — 25 October 2026

Implemented on deploy/adtech-pilot: an independent 60-second watchdog reads actual Shopify successful SALE/CAPTURE payments with a 15-minute freshness window. It rejects test/cancelled/unpaid/refunded orders, non-EUR payments, countries outside DE/AT, future timestamps, incomplete pagination and unavailable providers. Evidence includes aggregate counts only; no customer/order details or secrets are persisted. Shopify payment evidence does not establish Meta attribution or contribution margin. The owner's previously confirmed Purchase measurement remains accepted; no new pixel setup/test is requested.

The watchdog pauses only the campaign identified by the existing durable Pilot claim and confirms PAUSED remotely, even when dry-run is enabled. A fresh payment can resume that same campaign only with explicit existing paid switches, passing account/pixel/billing readiness, exact DE/AT targeting, one ACTIVE child ad set at 500 EUR cents/day and an unexpired original schedule of at most seven days. It never extends the schedule or changes budgets. Ambiguous activation is compensated by PAUSED; unconfirmed pauses remain explicit failures. The publisher rechecks fresh purchase evidence before each activation, retains campaign identity through watchdog pauses, and fixes the obsolete product_id argument passed to MicroBudgetGate. New campaign retries remain subject to the existing durable one-campaign claim.

POST /trigger requires X-Pilot-Token, using PILOT_TRIGGER_TOKEN if configured or the existing PILOT_ADMIN_KEY; GET /pilot/status uses the original administrator header. The daemon wakes at most every 60 seconds, attempts catalog publication on a five-minute schedule, and retains hourly reporting. Actual Meta delivery metrics are read from the managed campaign's Insights edge; overlapping purchase counters are not summed. Scaling remains blocked until order attribution and landed costs are established.

Validation before deployment: 56 unit tests pass, Ruff passes, mypy passes. Includes real-payment rejection cases, paginated order deduplication, failed-provider closure, exact campaign pause/reuse, excess-budget rejection, ambiguous activation compensation and trigger authorization. No paid creative generation, catalog recreation, token reset or spend activation was performed.

Fresh Higgsfield inventory: 11 completed Ads Studio runs from 23 October are 1:1 image creatives, not downloadable videos. The ordinary video project contains zero assets. The installed Ads Studio connector does not return export URLs; importing those pictures as videos or claiming they are queued/published would be false. Exact remaining dependency: an exportable image/video media URL or supported authenticated export API, plus the existing organic queue import/receipt integration. Do not generate replacements. Meta catalog read 400/code100/subcode33 and unavailable authorized TikTok/Sell The Trend feeds are external blockers, not fixed by fresh purchase gating. Production deployment status must be appended only after observing SUCCESS and watchdog output.

Deployment a1af8a9c82652f96c13097d43fa91a3e4fdfb331 reached Railway SUCCESS as 59b6dc8f-05bb-4c27-bc05-17fb6bd61354. Healthcheck passed, 384 feed products remain validated, paid gates remain dry-run/0 EUR, and the independent watchdog started. Its first Shopify read returned SHOPIFY_ORDER_QUERY_REJECTED; this is not proof of broken credentials or a reason to reset the working app. Follow-up bounds orders to 25 and transactions to 10 per order (preserving top-level pagination), requires transaction.test=false as well as order.test=false, and records only safe GraphQL error code/type/field diagnostics. The exact runtime rejection must be resolved/identified before claiming the purchase reader works.

The live organic public-results endpoint at 2026-10-25T06:14:53.811Z reports 92 published records in seven days: Facebook 14, Instagram 14, TikTok 23, Pinterest 41. Examples: https://www.instagram.com/p/De4b0AKGKzY/ and https://www.facebook.com/122263627130172038/posts/122265941942172038 . These are existing organic publications, not proof of Ads Studio export/import or new publications caused by this repair. No organic pipeline was recreated.


Deployment 4648d53e27e21f4b31269348cb1a104edd389c63 reached SUCCESS as 504c3661-b2f4-4d83-81b6-dbcb1b0c4b98. Runtime diagnostic identifies GraphQL ACCESS_DENIED, while the same bounded query succeeds through the connected Shopify tool (no matching orders today). The follow-up adds one bounded client-credentials grant using the existing installed app's client ID/secret when the referenced direct token is denied; it never reinstalls the app, alters the original token, or adds scopes. A successful current token is reused and renewed before expiry. Continuing denial records safe field path and whether read_orders is granted to this exact runtime app; do not conflate the connected Shopify tool's authorization with the runtime app. 57 unit tests, Ruff and mypy pass, including one-time token recovery and original-secret preservation. Paid spend and paid generation remain disabled.

## Catalog-independent website ads and signed payment receiver — 25 October 2026

Owner authorized implementing the proposed alternative without changing Meta settings. Added PILOT_AD_MODE=website_sales: publisher uses a direct Shopify image/link creative or carousel of up to ten distinct eligible product URLs, German neutral copy and PURCHASE optimization. Product candidates still come from the existing full validated feed; unavailable, explicitly inactive/rejected/non-EUR and invalid-link products are excluded. This is not a catalog DPA and does not promise that all 384 products appear in one carousel. Existing campaign identity, pause compensation, DSA, account/pixel, budget and fresh-payment gates are retained. Website mode does not resolve/read a Meta catalog/product set. The catalog adapter remains available in catalog mode. The initial carousel is retained with the managed campaign; automatic creative rotation across the entire catalog is not implemented by this change.

Added POST /webhooks/shopify/orders (also supports per-topic routes). It accepts only orders/paid, orders/updated, orders/cancelled and refunds/create from the configured store after constant-time HMAC verification of the raw body against SHOPIFY_WEBHOOK_SECRET. This is the signing secret for merchant-admin-created webhooks, not SHOPIFY_CLIENT_SECRET. Signed sample/test orders, stale/future payments, non-DE/AT, non-EUR and unpaid/zero-value orders cannot unlock spending. Body hashes deduplicate deliveries; first payment time never advances on replay. Persistent refund/cancel tombstones reject late payment replay. SQLite stores only opaque order hashes and payment/invalidation metadata, never the original payload, customer data or signing secret. The receiver never directly invokes Meta activation.

PurchaseEvidence can read these durable events using PILOT_PURCHASE_SOURCE=shopify_webhook, without calling the blocked Orders API. Receiver secret absence or DB failure stays fail-closed. GET /webhooks/shopify/setup exposes only public route/configuration metadata; private /pilot/status retains administrator authentication. Database is on the existing /data volume at /data/adtech-pilot/payments.sqlite3. Existing store credentials and Meta dataset IDs are untouched. No new product, Higgsfield generation, paid campaign or ad activation was performed.

Public domain allocated on the same existing service: https://homestro-adtech-pilot-production.up.railway.app . Receiver setup URL: /webhooks/shopify/setup . Set website_sales/webhook modes and the persistent DB/public-origin values for the next deployment, retaining current dry-run and EUR0 budget. Missing external configuration remains explicit: the store's merchant webhook signing key must be saved privately as SHOPIFY_WEBHOOK_SECRET and the four subscriptions registered in Shopify admin. No subscription registration or genuine payment delivery is claimed by a successful server deploy. See docs/pilot-webhook-setup.md. Local validation: 69 unit tests, Ruff and mypy pass, including complete mock Meta website publishing with no catalog calls, repeat campaign identity, signature rejection, anti-replay, refund/cancel ordering, restart persistence, data minimization and public endpoint bounds. Actual deployment and receiver readback must be observed before reporting completion.


## Owner authorizes acquisition before first sale — 25 October 2026

Owner completed four Shopify merchant webhooks; one initial and three subsequent Shopify-Captain-Hook requests received HTTP200 on the existing receiver (08:51:27 and08:59:07/10/14 UTC). Deployment d033a313-1f71-4ef2-ab39-3a1cacc3e4a6 reached SUCCESS. Do not ask to configure these again. Test delivery is not a genuine sale or proof of Meta Purchase measurement.

Owner explicitly requests launch without a previous sale. Added explicit PILOT_LAUNCH_POLICY=bounded_acquisition_test: publisher and watchdog no longer demand a fresh real purchase in this mode. Actual payment evidence stays truthful, and default/unknown policies preserve the previous purchase requirement. Existing Purchase measurement confirmation, account readiness, one-campaign identity, 500cent daily budget, original seven-day schedule and pause compensation remain enforced. No paid switch is enabled by this code change; current unresolved live blocker is Meta Purchase measurement confirmation, not absence of sales.


## Explicit acceptance of measurement risk — 25 October 2026

After automatic approval review rejected falsely setting META_PURCHASE_EVENT_VERIFIED=true, owner explicitly approved the stated risk of a5EUR/day seven-day live test without verified Meta Purchase measurement. Added separate PILOT_ACCEPT_UNVERIFIED_MEASUREMENT=true, effective only with bounded_acquisition_test launch policy. This waives the measurement prerequisite for this bounded test and never sets or reports Purchase verification true. Actual purchase evidence, pixel/account/billing access, feed validation, one-campaign claim and seven-day500cent daily schedule remain enforced. No paid media generation authorized. Prior policy deployment365c7ae4-e7bf-43af-8df2-506ab67f0abf reached SUCCESS. Live spend enabling/deployment and actual Meta outcome must be read back before claiming launch.


Live bounded test created on25October2026: deployment92ff7e43-bc38-442a-ab62-d62ee0fc8f4e SUCCESS, campaign120254444566440274/adset120254444566670274/ad120254444567960274 accepted ACTIVE_PENDING_REVIEW. Website carousel10products, DE/AT, daily500cents, planned7days. Watchdog paused this same campaign because publisher deliberately schedules start15minutes ahead but watchdog wrongly demanded start<=now. Diagnostic deployment1c9a2f8a-095d-45f8-b087-e2e407adc8c8 SUCCESS proves exact remote daily_budget500/lifetime_budget0/statusACTIVE/countriesAT,DE/start2026-10-25T10:43:01+0100/end2026-11-01T10:43:01+0100. Repair accepts an upcoming start at most15minutes ahead while retaining exact500cent, single-adset, DE/AT, expiry and maximum7day checks. No campaign recreation or schedule extension. Actual resumed state must be verified after deployment.


## Autonomous total-test spend protection — 25 October 2026

Production schedule repair fde458f6-2414-42a7-9c84-845350f99251 SUCCESS; watchdog at09:31UTC confirmed managed campaign120254444566440274 ACTIVE, later cycles active_bounded_acquisition_test. This proves configured active state, not impressions, review approval or sales.

Added bounded-test lifecycle spend control to existing watchdog: reads Meta campaign-lifetime Insights (maximum, replacing moving last7d), pauses on unreadable spend, and at reported spend>=35EUR persists STOPPED_TEST_BUDGET before remote PAUSED confirmation. This durable status is checked before any reactivation and survives restarts; publisher retains existing single-campaign claim. No zero-sale/zero-purchase automatic performance kill is enabled because attribution is unverified. Daily500cent DE/AT seven-day controls remain unchanged; optimizer cannot raise budgets. Insights reporting and polling delay mean this is not an exact cent-level spending guarantee. Local74tests/Ruff/mypy pass; new test exercises a scheduled future start, total-spend stop, persisted restart and no ACTIVE writes. Deployment/live readback remains to be observed.


## Reported-ROAS performance rules — 25 October 2026

Owner supplied a standalone performance script and requested implementation in the existing Pilot. Integrated into existing performance_loader/daemon/watchdog instead of creating another campaign, service, cron or credential configuration. Current budget remains500cents/day, original7day schedule; supplied example100EUR/day ceiling is not adopted as new spending authorization. Meta API version stays existingv26.0, bearer header, timeouts, HTTP validation, exact campaign/EUR scope and no pagination ambiguity. Loader rejects duplicate summary rows/action keys and calculates reported revenue/spend ROAS without double counting overlapping purchase actions. maximum means lifetime, not last24h; yesterday window is available as a separate explicit read and cannot be used for lifetime stop decisions.

Performance decision now runs in bounded-test watchdog. Empty delivery data holds; lifetime spend>15EUR with zero Meta-reported purchases stops and persists STOPPED_PERFORMANCE. This is explicitly based on reported counts with unverified attribution, not proof of no genuine Shopify sales. At35EUR reported lifetime spend, total test stop takes priority. Neither stop can be automatically reopened on restart or new Purchase; no duplicate campaign is created. At ROAS>=3 and reported purchases>=3, reports20percent proposal only, held by5EUR cap and unverified profit. At weak ROAS it reports minimum-test-budget hold; no budget writes or speculative scale. Reads/reporting delays and missing conversion measurement can delay or prematurely trigger reported-performance decisions.

Validation81tests/Ruff/mypy pass, including both durable stop paths across SQLite restart with no ACTIVE writes, threshold boundaries, zero-data hold, lifetime/yesterday separation, malformed metrics, high-ROAS cap and canonical purchase counter. Prior total-spend deployment338a0c4b-fcc4-4f93-9b97-342a6549ab48 was SUCCESS and watchdog at09:38UTC confirmed same campaign active. New deployment and live decision must be observed separately. Trend APIs still unavailable; no paid data subscription, product import, creative generation or alleged full Tanganica parity.


## Durable autonomous product exploration — 25 October 2026

Performance rules deployment3a8077e4-d399-46ae-8b7e-62d6bec44c64 SUCCESS, watchdog active on owned campaign120254444566440274. Startup metrics NO_DELIVERY_DATA; do not claim impressions/sales.

Implemented AutonomousBrain using existing persistent audit SQLite and existing Shopify feed. Enabled separately with PILOT_BRAIN_ENABLED=true, only on live website_sales/bounded_acquisition_test with all existing publication gates. Checks exact account/campaign identity, one ACTIVE500cent DE/AT adset with original <=7day schedule and one existing ACTIVE ad. Reads actual metrics and remote creative/page; adopts initial product URLs only after real delivery data is available. Persists selection counts and current product IDs. Never confuses exposure selections with sales/demand. Least-explored eligible distinct product URLs are selected in category-diverse batches<=10; optional completed public-ad longevity matches may prioritize ties only, never establish profit. Existing Meta credential can attempt Ad Library read; API authorization failure stays a failed scan, never fabricated trends. No new credential requested/reset.

At most one creative replacement per24h and only after>=2.50EUR additional reported campaign spend since prior experiment baseline. Keeps campaign with reported purchase andROAS>=1.5; no claim of per-product attribution. Neutral German message variants use current real feed images/links, no invented delivery/quality/guarantee promises, no AI generation cost. Reuses same campaign/adset/ad, changes only that ad's creative, never status/budget/end time. New creative needs Meta review and no delivery is guaranteed. At5EUR/day this explores limited batches, not all384 simultaneously; original7day experiment is never extended.

Before remote create it atomically reserves a unique durable intent. Confirmed creative IDs are stored before attaching. Lost create responses block blind retries; lost attach responses reconcile current creative after restart without duplicate generation/ad creation. Durable test stop is rechecked before attachment. Memory and intent rows contain IDs/product story only, no credentials/customer payload. Unknown external ad/creative changes are held. New module uses existing image/link paths; does not export nonexistent Higgsfield videos or create replacement paid media.

Validation87unit tests/Ruff/mypy: complete MockTransport creative/ad update,24h/exposure-spend guard, category/eligibility/dedup, restart reconciliation, lost-create no-retry, lost-attachment no duplicate, no budget/status writes, public-longevity tie priority. New deployment/live brain status remains to be observed. Full omnichannel parity, profit attribution/landed costs, winner-level causal product attribution and external trend feeds remain incomplete; do not call this a clone of Tanganica/Christiani/Expoya/Crush.


Brain deploymentc21222c7-2db9-4b63-bb66-8005464035c4 reached SUCCESS. Runtime at09:52UTC confirms current campaign active and brain hold/NO_DELIVERY_DATA; no replacement creative or product rotation has yet occurred and none is claimed. Archive fallback attempted the existing credential once and returned HTTPStatusError. Follow-up classifies400/401/403/404 as an operation rejection on normal daily schedule instead of repeated short-backoff probing. Does not reset credentials or interfere with working campaign access. Public source remains unavailable, never fabricated.


## Signed order attribution and conservative economics — 25 October 2026

Prior brain follow-up deployment7cfe3a27-00aa-4288-9d3f-2f3fb5bac999 SUCCESS. Owner requests completion; connected Shopify read-only schema+validated query confirms first50variants return EUR inventoryItem.unitCost (some extreme values exist; this is not landed cost). Do not request/reset existing access. Added bounded paginated runtime sync using existing SHOPIFY_ACCESS_TOKEN, preserving previous cost snapshot on failed/incomplete reads and replacing atomically only after a complete successful scan. Costs<=0/missing/nonEUR remain unknown. Snapshots expire for order costing after7days and only cost values observed before payment can become immutable order COGS. Runtime credential scope is distinct from connector scope; a connected-tool success does not establish runtime sync success.

Existing signed Shopify receiver now also records minimal order economics in its same SQLite transaction: hashes, campaign/ad/experiment IDs, payment time, net-of-tax revenue and known COGS only, never names/email/address/full payload. HMAC-signed experiment URL references, exact own-site landing and matchingUTMs are required. Test/forged/expired/future references cannot create attributed records. Refund/cancel tombstones invalidate revenue even out of order; changes in monetary/quantity fingerprints invalidate economics while unchanged nonfinancial updates preserve it. This is observed signed-link attribution, NOT verified causal incrementality or Meta attribution.

Brain's next valid ad update tags every direct/carousel CTA with signed reference and UTMs, preserving variant parameters and destinations. Existing ad first receives a one-time tracking bootstrap with same products after real delivery data and ACTIVE effective status; no current pending review/no-data ad is churned. Bootstrap and subsequent creative replacements use the existing durable reserve/create/attach/reconcile machinery, no new campaign/ad/adset, no budget/status/schedule mutation or paid generation. The tracking installation and subsequent genuine attributed order have not yet been verified live. First untagged clicks cannot be retrospectively credited.

GET /pilot/economics and /pilot/economics/orders remain admin-header protected. POST /pilot/economics/expenses requires same admin, existing hashed order, explicit actual-cost confirmation and nonnegative finite cent-format fulfillment/payment/return/other costs. These are actual expense inputs, never estimated as customer shipping charge or defaultzero. Contribution after reported ads remains null until every cost and net revenue is known; refunds and unknown ad spend also block it. It is not verified net profit and cannot unlock scaling. A signed tagged real paid order can prevent the15EUR Meta-zero-purchase stop, without falsely changing Meta's reported purchase count;35EUR total stop remains absolute policy with reporting-delay caveat.

Current validation97tests/Ruff/mypy pass: signed webhook end-to-end attribution/dedup/COGS, PII absence, tamper/expiry/wrong key, refund ordering and monetary updates, paginated cost sync with failure preservation, same-product tracking bootstrap and learning guard, protected expense API and required confirmation, no budget writes. Existing81/87test behaviors preserved. Next deployment and actual unit-cost sync/ad effective status must be observed. Full external-channel parity, supplied paid trend feeds, landed expense data and causal profit attribution cannot be claimed complete from code/tests alone.


Economics deployment24791fe3-40c4-4adc-be1f-ae37311e2bb6 SUCCESS. Runtime10:10UTC confirms ad_effective_statusACTIVE and no delivery metrics; no impressions or sales claimed. Runtime cost sync reports COST_SOURCE_NOT_CONFIGURED because the new adapter required direct SHOPIFY_ACCESS_TOKEN although existing installed app uses client-credentials flow. Repair reuses the already configured app client ID/secret to obtain an ephemeral token only when direct token is absent, without reinstalling/resetting/storing new credentials or adding scopes. Existing direct token behavior preserved. Added transport test verifies bounded grant and read without changing environment credentials;98tests expected after validation.


Cost-flow deployment6a4dfc98-0a4e-4b56-aba9-ce10fd39e06f SUCCESS. Runtime10:12UTC synchronized1461EURunit-cost variants, missing0, with existing app credentials; feed384products preserved. Actual fulfillment/fees/returns costs still not inferred. Ad effective statusACTIVE, Insights empty.

Follow-up removes the unnecessary delivery prerequisite ONLY for one-time same-product tracking installation: an owned ACTIVE ad may receive signed URLs before its first recorded impression/click. It preserves product batch and selection counts and uses durable same-ad reconciliation; tagged ads still cannot rotate without actual delivery and the24h/2.50EUR guards. This avoids losing initial untagged-click attribution and is not a general no-data creative refresh. Additional transport tests cover bootstrap with empty Insights and no-data hold after tracking is installed.100tests expected after validation. Actual live attachment must be observed.


Tracking bootstrap deployment79f3f04d-e958-45da-9fb4-987c5e12d3dd SUCCESS. Runtime10:16UTC: unit-cost1461sync succeeded, campaign remains ACTIVE, first creative POST timed out at the original15second client read deadline. Durable RESERVED intent prevented replay/duplicate creation, as designed. No tracking attachment was claimed. Follow-up scans at most5pages of the same account's creatives with fixed graph host/cursor parameters; only exactly one match on reserved unique name, own page, complete destination-link set including signed reference and message can recover its ID. Incomplete/zero/ambiguous reads remain blocked and never create again. Known ID then uses existing idempotent attach/reconcile path; original ad/campaign/budget untouched. Future first-time creative creation has a60second read timeout. Added lost-response recovery transport test proves one creation, one attachment, persistent ID.101tests expected after validation. Live recovery result still must be observed.


Reconciliation deployment49351f3a-b008-45bd-889a-494c19bfa3f1 SUCCESS. Runtime10:19UTC: exact creative recovery found0matches; owned campaign remains active, cost1461sync valid. Tracking attachment is still unconfirmed, not complete. Follow-up canonicalizes destination query ordering/encoding while preserving scheme/host/path/all query pairs/fragment, and adds only aggregate named-candidate count to distinguish no remote object from content mismatch. Never relaxes name/page/destination/message scope, creates no second uncertain creative, does not claim live order attribution until attachment is confirmed.


Canonical recovery deployment9cfc1de5-0b8e-4993-acea-68005337f656 SUCCESS. At10:23UTC complete account read reported named_candidates0/matches0, so the earlier timed-out POST has no discoverable creative. Added bounded negative reconciliation: at least15minutes from reserved intent plus two complete zero-name/zero-content inventory reads separated>=5minutes are required to atomically reserve ONE recovery attempt with60second timeout. No retry on partial/ambiguous reads, no second recovery attempt, no new ad/adset/campaign or spend change. This is a bounded reconciliation retry, not blind replay; without provider idempotency an extremely late orphan creative cannot be categorically excluded, but only the existing one ad can be attached and receive spend. Persistent match recovery still takes precedence. Minimum experiment24h now starts at confirmed attachment time, with current reported spend baseline, rather than old planned request time. Added durable one-retry/cooldown test.102tests expected after validation. Actual recovery remains pending its first recorded negative-read interval.
