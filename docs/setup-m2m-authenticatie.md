# Machine-to-Machine authenticatie opzetten voor Business Central

Hoi Erik,

We hebben de BC API succesvol getest via een gebruikerslogin. Voor de automatisering hebben we een **machine-to-machine verbinding** nodig, zodat onze systemen zonder menselijke tussenkomst met BC kunnen communiceren.

Hieronder de stappen. Je hebt **Global Admin** of **Application Administrator** rechten nodig in Azure.

---

## Stap 1: App Registration aanmaken in Azure Entra ID

1. Ga naar **https://entra.microsoft.com**
2. In het linkermenu: **Applications** > **App registrations**
3. Klik bovenaan op **+ New registration**
4. Vul in:
   - **Name:** `Bratra Integratielaag`
   - **Supported account types:** kies **Accounts in this organizational directory only** (single tenant)
   - **Redirect URI:** laat leeg
5. Klik op **Register**

Na het aanmaken kom je op de overzichtspagina. Noteer deze twee waarden:
- **Application (client) ID** -- dit hebben wij nodig
- **Directory (tenant) ID** -- hebben we al (`304a5907-1023-4a8e-a748-57ee5559fb42`)

---

## Stap 2: Client Secret aanmaken

1. Blijf op de pagina van de zojuist aangemaakte app
2. In het linkermenu: **Certificates & secrets**
3. Klik op **+ New client secret**
4. Vul in:
   - **Description:** `Bratra integratielaag production`
   - **Expires:** kies **24 months** (of wat jullie beleid voorschrijft)
5. Klik op **Add**
6. **Kopieer direct de Value** (het secret) -- deze wordt maar eenmaal getoond!

Stuur ons:
- Het **Client ID** (uit stap 1)
- Het **Client Secret** (de Value uit deze stap)

---

## Stap 3: API Permission toevoegen

1. Blijf op de pagina van de app
2. In het linkermenu: **API permissions**
3. Klik op **+ Add a permission**
4. Kies het tabblad **APIs my organization uses**
5. Zoek op: **Dynamics 365 Business Central**
6. Kies **Application permissions** (niet Delegated!)
7. Vink aan: **API.ReadWrite.All**
8. Klik op **Add permissions**
9. Terug op de permissions pagina: klik op **Grant admin consent for [tenant naam]**
10. Bevestig met **Yes**

Na deze stap moet er een groen vinkje staan bij de permission met status **Granted**.

---

## Stap 4: App registreren in Business Central

Nu moet BC weten dat deze app mag binnenkomen.

1. Open **Business Central** (https://businesscentral.dynamics.com)
2. Ga naar de **Sandbox_DEV_20251128** omgeving
3. Zoek via de zoekbalk (bovenin) naar: **Microsoft Entra Applications**
4. Klik op **+ New** om een nieuw record aan te maken
5. Vul in:
   - **Client ID:** plak hier het **Application (client) ID** uit stap 1
   - **Description:** `Bratra Integratielaag`
   - **State:** zet op **Enabled**
6. Klik op **Grant Consent** als dat gevraagd wordt

---

## Stap 5: Permission Sets toewijzen in Business Central

Nog op dezelfde pagina (Microsoft Entra Applications), bij de zojuist aangemaakte app:

1. Scroll naar het gedeelte **User Permission Sets** (onderaan de kaart)
2. Voeg de volgende permission sets toe:
   - `D365 BASIC`
   - `D365 BUS FULL ACCESS`
3. Dit geeft de app leestoegang tot alle standaard BC entiteiten

> **Let op:** als jullie liever meer restrictieve rechten geven, kan dat ook. Voor de testfase is D365 BASIC + D365 BUS FULL ACCESS het makkelijkst.

---

## Wat wij nodig hebben van jou

Na het doorlopen van bovenstaande stappen, stuur ons:

| Gegeven | Voorbeeld |
|---------|-----------|
| **Client ID** | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| **Client Secret** | `abc~defghijklmnop...` |

De Tenant ID en environment naam hebben we al.

> **Veiligheidstip:** stuur het Client Secret via een beveiligd kanaal (bijv. apart bericht, niet in dezelfde email als het Client ID). Het secret is in feite een wachtwoord.

---

## Wat dit oplevert

Met deze setup kunnen onze systemen automatisch:
- Data uitlezen uit BC (artikelen, klanten, leveranciers, orders, facturen)
- Straks orders aanmaken in BC (action orders, inkooporders)
- Zonder dat iemand hoeft in te loggen

De app heeft geen toegang tot Azure-resources of andere Microsoft-diensten, alleen tot Business Central.

---

## Later: productie-omgevingen aansluiten

De App Registration in Azure (stap 1-3) hoeft maar **eenmaal** te gebeuren. Dezelfde app kan meerdere BC-omgevingen en bedrijven benaderen. Wat er per omgeving nog wel moet gebeuren is stap 4 en 5 herhalen **in die specifieke BC-omgeving**.

### Per nieuwe BC-omgeving (bijv. productie, of een ander bedrijf)

1. Open **Business Central** en wissel naar de betreffende omgeving (bijv. `Production`)
2. Zoek naar **Microsoft Entra Applications**
3. Maak een nieuw record aan met **hetzelfde Client ID** als de sandbox
4. **State** op **Enabled**
5. **Permission Sets** toewijzen: `D365 BASIC` + `D365 BUS FULL ACCESS`

Dat is het. Geen nieuwe App Registration, geen nieuw secret.

### Wat wij aan onze kant doen

Wij passen alleen de **environment naam** aan in onze configuratie. De rest (Client ID, Secret, Tenant ID) blijft hetzelfde.

### Overzicht: wat is eenmalig vs per omgeving

| Actie | Eenmalig | Per omgeving |
|-------|----------|--------------|
| App Registration in Azure Entra ID | x | |
| Client Secret aanmaken | x | |
| API Permission + Admin Consent | x | |
| App registreren in BC (Entra Applications) | | x |
| Permission Sets toewijzen in BC | | x |

### Toekomstige BC-bedrijven

Bratra heeft drie bedrijven (Pet Products, Non-Food, Food) die uiteindelijk allemaal in BC komen. Als die in **dezelfde BC-omgeving** draaien, hoeft er niets extra's -- de app heeft dan automatisch toegang tot alle companies binnen die omgeving. Als ze in **aparte omgevingen** draaien, herhaal dan stap 4-5 per omgeving.

---

Mocht je ergens vastlopen, bel gerust. Het zijn in totaal 5 schermen en kost ongeveer 10 minuten.
