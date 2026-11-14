# Robin Foundation CRM

Een CRM voor Robin Foundation dat laat zien **waar het gedoneerde geld van iedere donateur heen gaat**.

## Het principe: donatie → cel → besteding → bericht

1. **Donatie**: een donateur geeft aan één van de vier bestemmingen:
   - 🍲 **Schoolmaaltijd** (standaard € 0,50 per maaltijd)
   - 🎒 **Schoolgeld**: toelatingsgeld per kind per schooljaar (standaard € 150)
   - 🌀 **Noodfonds stormen & orkanen** (vrij bedrag)
   - 🩺 **Gezondheidspakket** (standaard € 25 per pakket)
2. **Cel**: elke ontvangen donatie komt in een **eigen cel**, een apart potje dat bewaard blijft tot het geld echt wordt uitgegeven.
3. **Besteding (cel triggeren)**: een medewerker legt een besteding vast (bv. "400 maaltijden voor Escuela Esperanza"). Het geld komt
   - uit **specifiek geselecteerde cellen** (pagina *Cellen* → selecteren → *Geselecteerde cellen besteden*), of
   - automatisch uit de **oudste cellen eerst** (FIFO).

   Een cel kan deels besteed worden; één besteding kan uit cellen van meerdere donateurs komen.
4. **Bericht van de ontvanger**: aan een besteding koppel je een **brief, filmpje, foto of tekst** (upload of URL, ook YouTube/Vimeo-embed). Alle donateurs van wie geld in die besteding zat, krijgen het in hun portaal plus een e-mailmelding.

## Onderdelen

Iedereen logt in via **één inlogpagina: `/login`**. Je kiest daar of je inlogt als donateur, ontvanger of medewerker, en komt daarna in de juiste omgeving. Open je zonder in te loggen een van de pagina's hieronder, dan word je eerst naar `/login` gestuurd en daarna teruggebracht.

| Onderdeel | URL | Voor wie |
|---|---|---|
| Beheeromgeving (CRM) | `/admin` | Medewerkers |
| Donateursportaal | `/portal` | Donateurs |
| Publiek leaderboard | `/leaderboard` | Iedereen |
| Ontvangersportaal | `/ontvanger` | Kinderen (met begeleider), scholen, projecten |

## Chat tussen ontvanger en donateur

Ontvangers kunnen inloggen op `/ontvanger` en chatten met de donateurs van wie geld aan hen is besteed. Donateurs chatten via het tabblad **Chat** in hun portaal. Een medewerker zet de inlog aan bij *Ontvangers → 🔑 Inlog & chat*.

Veiligheid staat voorop, omdat veel ontvangers kinderen zijn:
- Je kunt alleen chatten met een donateur of ontvanger als er echt geld van die donateur aan die ontvanger is besteed.
- Berichten van en naar **kinderen** worden altijd eerst door een medewerker goedgekeurd (*Chatmoderatie*). Bij een kind is een **begeleider** verplicht.
- Voor scholen en organisaties kan de moderatie uit. Berichten met **telefoonnummers, e-mailadressen, links, social media, adressen of geldverzoeken** worden altijd eerst tegengehouden.
- Een anonieme donateur blijft ook in de chat anoniem ("Anonieme donateur 1"). Donateurs zien van de ontvanger alleen de naam, en de foto alleen als daar toestemming voor is.
- Een donateur krijgt een e-mail als er een nieuw (goedgekeurd) bericht van een ontvanger is.

**Donateursportaal**: overzicht en impact ("4 schooljaren, 7 pakketten"), eigen cellen, *Waar gaat mijn geld heen?* (de hele reis per donatie), berichten-inbox met brieven, foto's en filmpjes, doneren, leaderboard met eigen positie, jaaroverzicht voor de belastingaangifte (ANBI), en profiel- en privacy-instellingen (**anoniem blijven** of een eigen weergavenaam).

**Leaderboard**: anonieme donateurs verschijnen als "Anonieme donateur" (zonder plaats). Hun bedragen tellen gewoon mee. Te filteren op periode en bestemming. Nieuwe donateurs staan standaard op **anoniem** (AVG); hun naam is alleen zichtbaar na toestemming.

**Beheer (CRM)**:
- Dashboard: opgehaald, wachtend in cellen, besteed, saldo per bestemming, grafiek, langst wachtende cellen, taken
- Donateurs: zoeken, filters, tags, segmentatie, CSV-export, profiel met impact, geldreis, contactmomenten, taken, e-mails, portaaltoegang, jaaroverzicht, AVG-anonimiseren
- Donaties: registreren, wijzigen, filters, CSV-export (een donatie die al besteed is, is financieel vergrendeld)
- Cellen, bestedingen (met *terugdraaien*), ontvangers (met toestemmingsvlag voor foto/verhaal)
- Taken, campagnes met doel en voortgang, rapportages (per jaar, bestemming, maand, betaalwijze, donateursbehoud, top 10)
- E-mail log, gebruikersbeheer (beheerder of medewerker), audit log, instelbare kosten per eenheid

## Inloggen als donateur of ontvanger (meekijken)

Beheerders zien bij een donateur de knop **👁️ Inloggen als donateur** en bij elke ontvanger **👁️ Inloggen als**. Het portaal opent dan in een nieuw tabblad, precies zoals die persoon het ziet. Een paarse balk bovenaan laat zien dat je meekijkt, met een knop **Stoppen**.
- Het werkt alleen voor beheerders, ook als de persoon zelf nog geen wachtwoord heeft.
- Je kunt **alles** doen wat die persoon kan, zoals doneren, chatten en het profiel wijzigen. In het audit log staat welke beheerder het namens wie deed (bv. `medewerker:admin@… als donateur:1`).
- ⚠️ Overweeg dit voor productie terug te zetten naar alleen-lezen. Anders kan een medewerker namens een donateur met kinderen chatten.
- Een meekijksessie verloopt na 1 uur en wordt vastgelegd in het audit log.

## Starten

Vereist **Node.js 22.13 of hoger**. Er zijn geen npm-dependencies: de app gebruikt de ingebouwde `node:sqlite`.

```bash
npm start          # start op http://localhost:3000 (laadt demodata bij een lege database)
npm run seed       # database wissen en opnieuw vullen met demodata
npm test           # tests
```

Demo-accounts:
- Beheer: `admin@robinfoundation.org` / `admin123` (of `medewerker@robinfoundation.org` / `medewerker123`)
- Portaal: `sanne@example.nl` / `welkom123` (de eerste 12 demo-donateurs hebben dit wachtwoord)
- Ontvangers: `grace` / `welkom123` (kind, gemodereerd), `esperanza` en `santarosa` / `welkom123` (school/kliniek)

Omgevingsvariabelen: `PORT`, `CRM_DB` (pad naar het databasebestand, standaard `data/crm.db`), `CRM_UPLOADS` (standaard `data/uploads`), `CRM_RSIN` (voor het jaaroverzicht).

## Voor productie nog te doen

- **Betalingen**: doneren in het portaal is gesimuleerd. Koppel een betaalprovider (bv. Mollie) en zet een donatie pas op *ontvangen* na de betaal-webhook.
- **E-mail**: berichten worden in de *E-mail log* gezet en niet echt verstuurd. Koppel een SMTP- of mailprovider in `sendMail` (`src/services.js`).
- **Uploads** staan in `data/uploads` en zijn bereikbaar voor iedereen die de URL kent. Overweeg afgeschermde opslag.
- Draai de app achter HTTPS (cookies krijgen `Secure` bij `X-Forwarded-Proto: https`) en maak back-ups van `data/crm.db`.
- Zelfregistratie met een e-mailadres dat al bekend is, wordt geweigerd: een medewerker geeft dan via het CRM portaaltoegang. Voeg e-mailverificatie toe als je dit wilt automatiseren.

## Structuur

```
server.js          HTTP-server, routing, statische bestanden
src/db.js          schema (SQLite) en standaard-bestemmingen
src/services.js    domeinlogica: donaties, cellen, bestedingen, berichten, leaderboard
src/api.js         API-routes (publiek, portaal, beheer)
src/auth.js        wachtwoorden (scrypt) en sessies
src/seed.js        demodata
public/            frontend (vanilla JS): admin, portal, leaderboard
test/              tests (node:test)
```
