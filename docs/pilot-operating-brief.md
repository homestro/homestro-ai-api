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
## Kontrola adtech feedu — 23. 10. 2026
Railway služba `homestro-adtech-pilot` (production, service `f2fe8c96-d681-46ff-ae94-465d78b9dd05`) byla nasměrována na existující produktový XML feed Pilota na Railway doméně. Aktualizovaný deployment `0003dae8-0ad1-4b8f-a9b1-8aec31ce25fd` je `SUCCESS`. První heartbeat načetl 384 aktivních nabídek z feedu (`source_format=xml`, 0 odmítnutých řádků); nejde o všech 384 produktů Shopify ani o potvrzení objednávek.

Placený prodej se tím nespustil. Výsledky stále blokují: `NO_VERIFIED_CHANNEL_METRICS_LOADER`, vybraný product ID není v nově validovaném feedu a existuje již jednorázová Meta kampaň `120254321479480274` ve stavu `ACTIVE_PENDING_REVIEW`. Kreativa se v tomto běhu nevytvořila (`VERIFIED_PRODUCT_IMAGE_OR_LOGO_MISSING`). Běh zůstal v režimu read-only pro optimalizaci; žádné nové reklamní objekty ani objednávky nejsou doloženy. Veřejný feed obsahuje jen položky, které splňují podmínky feedu; deaktivované nebo neprodejné produkty do něj patřit nemají.

### Kontrola běhu a kreativ — 23. 10. 2026, 19:00 UTC
Hlavní organická služba `homestro-ai-api-fixed-current` je `live`, deployment `79ba045f-fd20-475a-8190-94e21af581fb` má stav `SUCCESS`; veřejná Railway doména je `https://homestro-ai-api-fixed-current-production.up.railway.app/`. Adtech služba je také `live` a bez staged změn.
Živý Railway stav adtech služby: `live`, poslední deployment `0003dae8-0ad1-4b8f-a9b1-8aec31ce25fd` `SUCCESS`, bez staged změn. Poslední heartbeat (18:37:54 UTC) potvrdil čtení 384 položek XML, ale také zablokovanou kreativu kvůli chybějícímu ověřenému obrázku/logu, neznámému ověřenému načítání výsledků prodejních kanálů a produktovému ID mimo feed. Automatický optimalizátor zůstává `READ_ONLY`, `dry_run=true`, limit 0 EUR.

Ads Studio Homestro (`4814a68e-9317-4ec6-94e8-c24fab7b8e80`) má dokončený profil a 11 produktů; žádné existující Ads Studio runs nebyly nalezeny. Shopify konektor v tomto běhu vrátil `Authentication required`, proto úplný živý Shopify katalog nebyl z tohoto rozhraní ověřen; to samo o sobě nedokazuje chybu již běžícího Railway Shopify napojení. Pro 11 již připravených Ads Studio produktů byl zjištěn přesný, nezávazný quote: 1 statická prodejní kreativa na produkt, 11 celkem, 44 Higgsfield kreditů (4 za kreativu), poměr 1:1, brand kit Homestro. Quote nic negeneruje, nerezervuje ani neutratí. Do generování se nepokračovalo bez výslovného schválení přesné částky kreditů. Těchto 11 položek není doložením, že Ads Studio obsahuje celý Shopify katalog.

Majitel výslovně schválil 44 kreditů pro 11 kreativ. Ads Studio přijalo jeden běh na produkt pro všechny vypsané produkty; run IDs: `234b98fc-9c29-4de7-971e-c5abfa7415a4`, `318a9486-5d88-4625-9bf9-e747f76a613a`, `5f8d8aef-b3b9-424f-976e-60b0d03417d4`, `5835191b-6ec4-4d6a-b870-862e25be5de0`, `edf31c2e-f2f7-4901-80cc-84ffddab3f06`, `177138c5-8808-4796-ad0c-cc1cdcac3cbc`, `f5ab5951-87a1-4fbd-a5a8-87c2225b7cab`, `6d3c5ed7-d8fd-4d79-8b41-d11f62c452f8`, `24b73ced-e684-448b-88bc-0d80998a5e1e`, `98f51cba-e481-448e-b07f-e597a9c15256`, `40e51364-2ae1-44eb-b068-38caaf3793e8`. Tool potvrzuje přijetí běhů, nikoli dokončené obrázky, import do Pilota ani publikaci. Žádný spend limit se tím nemění; ad budget zůstává 0 EUR. Novou Meta kampaň nelze vytvořit ani obejít již uplatněnou jednorázovou rezervaci/pending review.

### Trvalý rozsah produktového výzkumu — 23. 10. 2026
Majitel požaduje vybírat kandidáty z celého Shopify katalogu, nikoliv jen z 11 produktů v Ads Studio nebo z první stránky feedu; do výzkumu zahrnout i draft, archived, skryté a nové produkty. Tyto neprodejné stavy lze analyzovat a připravit, ale nesmějí být propagovány jako okamžitě koupitelné ani automaticky aktivovány v Shopify. Placenou kampaň lze vytvořit pouze pro ověřeně aktivní, skladem dostupnou a zákazníkovi dostupnou produktovou stránku po splnění měřicích a rozpočtových bran. Počet 384 z XML jsou položky/offer feedu, nikoli potvrzený počet unikátních Shopify produktů. Současný adtech worker čte jen veřejný XML feed a nemá přímý Shopify Admin katalogový reader; plný read-only import všech stavů tedy ještě není implementován. Již spuštěné Ads Studio běhy pro 11 produktů se nepovažují za celé pokrytí katalogu a nesmí se duplikovat.

Kód hlavního organického Pilota už používá stránkovaný Shopify GraphQL katalogový dotaz pro `active`, `draft` a `archived` produkty (30 ID na stránku) a pokračuje přes `pageInfo`; proto se nemění ani znovu nevytváří existující Shopify produktový import. Zbývá napojit tento úplný katalogový přehled na read-only výběr kandidátů v odděleném adtech/Ads workflow. Nedostupné produkty lze pouze analyzovat a připravit; do kampaně až po ověření prodejnosti. Nové video/kreativu pro existující produkt nevytvářet znovu, pokud již existuje použitelný asset; nejprve ověřit jeho převzetí a stav v publikační frontě.

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

## Autonomous product-demand planner — 23 October 2026
Prepared on branch `codex/homestro-sales-booster-20261023`; not deployed. The catalog sync now includes Shopify `active`, `draft`, and `archived` products for analysis. Archived/draft/rejected products remain ineligible for an ad test. New authenticated endpoint `GET /api/marketing/v2/ads/sales-plan` ranks products from 90-day Shopify product orders and bot-filtered human landing-page sessions, carts and checkouts. A test candidate additionally requires an active, marketing-ready product, a public Homestro purchase URL, available stock, an existing Shopify image, German reviewed product facts, reviewed selling price and verified margin of at least EUR 10. Ad copy reuses those facts and the existing product image; no generated asset or discount claim is added. The endpoint and scheduled 15-minute catalog sync only read reports and persist a one-hour cache. They never write to Meta, publish campaigns, change budgets or spend. Any future live test remains hard-capped at EUR 5/day for seven days and one campaign; scaling above that cap is disabled.

Live Shopify analytics connector check on 23 October: the 90-day product sales breakdown returned zero rows. The human-filtered landing report returned 16 paths; the busiest product path shown had three human sessions and zero carts/checkouts. Railway production logs independently report missing `read_reports`; this branch adds the scope to Shopify app configuration and OAuth request, which will require Shopify to grant it before the scheduled planner can read reports. The existing AdTech service has a one-campaign allowance already claimed in `ACTIVE_PENDING_REVIEW`; no second campaign was created. No new images/videos were generated. Local validation: marketing test suite 206/206 passed and API/regression suite 100/100 passed, including the new sales-plan and catalog coverage tests. PR/deployment and live campaign execution remain unverified.
## Ultimate growth-engine directive check — 23 October 2026
Rechecked Railway production directly: organic service `homestro-ai-api-fixed-current` is LIVE, deployment `79ba045f-fd20-475a-8190-94e21af581fb` SUCCESS; adtech service `homestro-adtech-pilot` is LIVE, deployment `0003dae8-0ad1-4b8f-a9b1-8aec31ce25fd` SUCCESS. No staged work. The organic worker is publishing approved social content in scheduled windows and its log confirms `adSpendEUR=0`; its Shopify analytics job still reports missing `read_reports`, so order/product-demand data is unavailable to the planner. The adtech heartbeat parses 384 XML offer rows (not verified as 384 unique Shopify products), with 388 warnings. It is not a whole-catalog Shopify Admin scan. Paid execution remains `READ_ONLY`, optimizer `dry_run=true`, budget 0 EUR; the single campaign allowance is already consumed by campaign `120254321479480274` in `ACTIVE_PENDING_REVIEW`. Additional live blockers: no verified sales-channel metrics loader, proposed product ID not present in validated feed, creative blocked for missing verified product image/logo, competitor Meta token missing, and Merchant Center credentials absent. The pasted Python is not deployable as the growth engine: one-page REST fetch truncates catalogs over 250; its Meta call creates only a campaign shell, not an ad/ad set/creative or budgeted delivery; SEO content is generic and overwrites without freshness/review checks; checkout query has no recovery-message delivery, consent, or discount workflow. Current code already has paginated Shopify catalog analysis, gated product SEO, and idempotent blog-draft creation, but no complete blog auto-publish or compliant checkout-recovery sender. Shopify checkout recovery also needs the relevant protected-data scopes and consent-aware delivery integration. No live campaign, product status, SEO fields, checkout, discount, or new creative was changed by this check.

Owner's attempted `/auth/install` action was confirmed in Railway HTTP logs at 20:11:37–20:11:39 UTC: install returned 302, callback returned 302, then the browser returned to `/`. Root cause: production branch `main`'s `server.js` OAuth scope list contains `write_products,read_products,write_content` and omits `read_reports`; the updated PR now asks for `read_reports` and `write_files` as well. PR #114 (`https://github.com/homestro/homestro-ai-api/pull/114`) contains the scope correction, product-demand planner and Turbo SEO work. The PR is ready for review; verify run 482 is in progress, and a main-branch overlap in `server.js`/this brief is being resolved while preserving both scopes. Production is still on deployment `79ba045f-fd20-475a-8190-94e21af581fb`. Do not retry the live install link before the updated OAuth route is deployed.

## Whole-catalog Turbo SEO implementation — 23 October 2026
Prepared in the local worktree, not deployed: the 15-minute Shopify sync now schedules a persistent rotating SEO pass of 25 catalog records per run (configurable 1–100), including active, draft and archived records already ingested by the Pilot. It writes the existing fact-reviewed German SEO title/description without changing product publication status, skips rejected products, and fills only blank ALT text on Shopify media in READY state. Existing merchant ALT text is preserved. The persistent cursor resumes after restart; Shopify write results and product-level failures are checked and logged. Shopify `fileUpdate` is added to the exact GraphQL mutation allowlist, and the OAuth route requests `write_files` alongside `read_reports` and existing scopes. The SEO blog lane now builds German articles only from reviewed copy and three verified benefits, links the product page, checks Shopify handles and ownership markers, and publishes at most one per day when the SEO auto-publish flag is enabled. It does not overwrite external articles or retry ambiguous writes blindly. Current live deployment does not contain this code; Railway needs a successful main-branch deployment and Shopify must grant the updated scopes before writes can begin. The existing three published SEO guide pages remain as verified in the owner screenshot. Validation: API/regression 100/100, marketing 211/211. No Shopify records were modified during implementation.


## Publisher adopts channel-signed purchase attribution — 25 October 2026
Existing signed click redirects now mint channel-bound pilot_ref destination tags at click time; Pinterest adds its signed direct destination only when actually submitting, never during draft preparation (avoids unstable revisions/duplicate drafts). Same own-shop destination and variant are preserved. Existing private publisher administrator key signs only organic channels, consumed by the adtech receiver through its existing PILOT_ORGANIC_API_KEY reference. Seven-day expiry means old Pinterest direct links cease contributing attribution after that window; no historical backfill or causal-sales claim. No TikTok consent, visual review, product/price or publishing quota bypass.221Node marketing tests passed; a synthetic Node output was independently verified by the Python decoder. Actual new social post or paid order not claimed. No products/videos/AI generation or paid campaign created. Deployment verification follows shipping.


## Whole-catalog autonomous preparation coordinator — 25 October 2026
Added CatalogBrain to the existing publisher, not a second publisher. The main service already ingests paginated Shopify active/draft/archived records; the eleven-item limit belongs only to the separate previously generated Higgsfield asset import. The new persistent PostgreSQL ledger covers all stored catalog product records, including blocked inactive/rejected/unavailable records, and counts unique Shopify image URLs separately from per-product references. No Higgsfield-only limit is applied.

The coordinator runs with the existing worker every five minutes, at most eight due products per cycle, and shares advisory lock73341002 with the full catalog sync. Never-attempted products precede previously attempted products; fresh human landing checkouts/carts may prioritize preparation, while stale/invalid signals do not establish intent. Work and retry deadlines persist across restart. Each product's failure is isolated. Unchanged verified cached assets are reused, missing originals are restored by the existing asset verifier, current native footage is rendered by the existing renderer, and exact compiled post identities are handed to the existing FB/IG queues. Source changes invalidate old approvals through existing ingestion. Pending/failed preparation backs off four hours; unchanged prepared products wait24hours, with normal full sync continuing independently. Existing social preparation and source-reviewed image approval run once after each successful batch; actual queue/approval/published status counts are read back. No new publication is inferred from a queued/approved row.

This coordinator uses a dedicated free ingestion path: no OpenAI key is passed to its source localizer and optional paid voice/image rendering is disabled in its renderer. Original product sources, German fact IDs, prices and fresh availability checks remain in force. Imported AI assets, Reels visual review, TikTok express consent, channel spacing/quotas and existing publication controls remain enforced. Missing motion video is recorded as MOTION_VIDEO_COST_APPROVAL_REQUIRED; the owner previously rejected photo-animation clips, so these are not silently substituted for genuine generated motion. Briefs carry source-linked German copy and grounded benefits, portrait format and product-fidelity requirements. No new product, paid AI call, paid campaign, token reset or cross-brand account reuse.

Protected GET /api/marketing/v2/catalog-brain reports coverage/states/tasks/actual existing queue receipts; POST .../run advances a bounded cycle only when the worker is enabled. Generated drafts are not live publication receipts. Adtech reads an authenticated, bounded, fresh counts-only summary through its existing publisher key and records organic_catalog_brain evidence, exposed in /pilot/brain. The services retain a single organic publication owner.

Validation: whole Node marketing suite227tests; new regressions cover >11catalog records, source media reuse, native-video planning, draft/rejected/unavailable exclusions, fresh-vs-stale human demand, bounded scheduling/reservation, per-product failure isolation, shared catalog lock, consumer handoff/readback and no inferred publication. No generated media quality/performance claim. Actual deployment/coverage readback follows shipping. Complete vendor parity and automatic paid motion/ads remain unverified and unauthorized.


## Autonomous recovery follow-up — 25 October 2026
Live deployments 84f798f0-8849-4479-9d5a-ba9721304cb8 (publisher1c3a571) and 0f94053e-f61d-4203-8393-e57262a89b67 (adtech9e45c61) both SUCCESS. Coordinator coverage239 persisted Shopify catalog records,3578 unique source image URLs,80 eligible,4 native-video products. Adtech observed78 prepared,2 waiting,159 blocked; due backlog drained automatically. These are preparation ledger states, not new publication proof. Existing publication report also contains historical public links and unresolved provider outcomes; do not equate its totals with this new coordinator.

Found SEO_ARTICLE_RECOVERY_REQUIRED aborting the whole blog lane. The follow-up performs up to5 uncertain-article read reconciliations per pass and continues to other eligible products without replaying an uncertain create. Unknown errors still stop the lane. Existing daily limit remains. Social recovery now reads a bounded provider post list once per tick when missing-ID intents exist, matches exact pilotPostId/productId/channel/account, rejects ambiguous matches, checkpoints the found provider ID, then performs the existing individual publication readback. Missing/ambiguous matches stay unresolved; no POST or consent bypass. Known provider-ID recovery remains unchanged. Social recovery log exposes counts only. No credential reset or new paid media. Local marketing suite230passed; shipping and live readback follow.


Production recovery release3089fd8 reached SUCCESS on deployment724cb910-e5f9-43ff-bf6c-5623ac9c5eb8. Restart completed221catalog records with0sync errors, AUTONOMY_READY and INITIALIZED. SEO advanced past the original uncertain article and exposed a second exact defect: ARTICLE_CREATE selected onlineStoreUrl, which is absent from Shopify's Article type (schema inspection). Remove that unused selection from the mutation and its exact runtime allowlist, preserving all input/content/fingerprints and duplicate protection. Shopify schema confirms id/title/handle/isPublished; its validation connector skipped standalone validation, so do not claim a remote validator pass. Existing uncertain attempts are not blindly replayed. Local231test suite passed before the schema follow-up; rerun follows. No token or integration replacement.


## Completed-motion consumer handoff and director readback — 25 October 2026
Protected POST /api/marketing/v2/generated-videos/:key/handoff now requires an existing completed provider task, exact source product/revision/task/output URL, actual visual preview and explicit product-fidelity review. It downloads only bounded MP4/octet-stream from provider CDN hosts without credentials or redirects, caches/checksums durably, and reuses the native import transaction/normalizer/queue deduplication. Public Higgsfield imports remain Higgsfield-only; internal Runway handoff independently verifies persisted reviewed task proof. A lost acknowledgement reads existing native queue receipts rather than regenerating/reimporting. Imported native channel review and TikTok preview/express consent remain separate. Read-only bounded automatic polling advances existing provider tasks to review_required without starting generation; conditional updates prevent a race from downgrading queued media. Logs exclude signed CDN output URLs. No Runway task/key was available and no paid request was made; live provider execution/visual fidelity remain unverified.

Catalog-brain report now bulk-reads actual current native queue receipts and includes only those matching each product's exact current source revision. Python bridge sanitizes the bounded100product projection; the director advances only evidenced work and preserves outages as historical receipts. No aggregate catalog count is converted into product publication. Earlier release21548c4 was independently checked in Shopify: article1010954305918 isPublished=true at /blogs/news/homestro-pet-cleaning-products-ear-cleaning-wipes-ear-care-fingertips-ear-mite-removal-cat-and-dog-e. Earlier social read-only recovery inspected9 and recovered3intents; other outcomes remain unconfirmed. Full validation and production readback follow this release.


## Whole-catalog evidence pagination — 25 October 2026
Protected catalog-brain report now supports a bound after cursor, stable product_id ASC and101-row lookahead with100returned rows. pageInfo.hasNextPage/endCursor supports complete catalog traversal; native current-revision receipts remain bulk-read only for that page. Invalid cursor types/length/control characters fail before queries. Python bridge validates all pages, repeated cursors and total raw-row coverage before claiming completeness, with a20page/2000record explicit ceiling. No plan, source eligibility, approval, consent or publication setting changed. Tests cover239records over100/100/39pages, final-record coverage, no repetition, empty terminal page and SQL-bound hostile input. Full243Node and244Python tests passed; Ruff/mypy80files passed. Shipping and actual cross-service whole-catalog readback follows.


## Final exclusion-policy alignment and full live readback — 25 October 2026
Live adteche3ad43e deploymente87f9b6b-0560-4d32-8c6e-14c329247809 and publisher8778e3e deployment412e9af2-feed-44c1-8855-edddb2e8068d SUCCESS. At22:50:29UTC the authenticated bridge read all239records across3pages with coverage_complete=true; director observed80eligible consumer source products and advanced9social tasks to consumer_evidence_observed. This is native-queue evidence, not new platform publication or profit.

Startup also exposed two owner-excluded products incorrectly recorded as waiting even though processProduct already refused them. The coordinator now receives the existing cfg.excludedProductIds and records PRODUCT_EXCLUDED_BY_POLICY in its own eligibility decision, so excluded products stayblocked and are not repeatedly reconsidered. Existing publishing exclusion remains unchanged. If the owner later removes an exclusion (or another eligibility blocker clears), a blocked row can become due again without requiring an unrelated source revision change. Full244Node tests passed; previous244Python/Ruff/mypy80files passed. Final policy-only deployment/readback follows; no consent, credentials, paid generation, ads budget or product state was changed.


## Permanent organic quota lock repair — 26 October 2026
Live publisher deployment350f1bfc-6226-4faf-a3f1-95689ab40446 SUCCESS logged DAILY_TOTAL_LIMIT=4/4 and six unresolved social recovery intents. This does not by itself identify which four native posts consume quota. Code inspection found every native recovery_required row counted forever, regardless of age, and reconciliation updated timestamps could renew spacing. Added immutable attempted_at, backfilled from earliest publishing event (fallback publication/previous update), recorded before remote mutation. Rolling native total/channel quotas and spacing use that send time; timeless same-product uncertainty/duplicate guards and recovery states remain unchanged. Definitive PRODUCT_NOT_FOUND before a TikTok/Pinterest send supersedes only the unsent approval; temporary source failures retain approval and attempted writes remain recovery_required. Full Node marketing suite247/247 passed, including two regressions. No new paid generation, products, ad spend, token replacement or consent/review bypass. Deployment and new public-post verification remain pending at preparation time.
