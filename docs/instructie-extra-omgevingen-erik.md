# Instructie: Bratra Integratielaag toevoegen aan extra BC-omgevingen

**Voor:** Erik
**Van:** Robert

Hoi Erik,

De koppeling met de POC sandbox werkt. We willen nu ook toegang tot de productie-omgevingen. Het goede nieuws: de Azure-kant (App Registration, secret, permissions) is al eenmalig gedaan. Je hoeft alleen in elke BC-omgeving de app te registreren. Dat zijn 2 minuten per omgeving.

---

## Wat je nodig hebt

Alleen dit Client ID (hetzelfde als bij de POC sandbox):

```
1690ac13-3f30-4482-b279-60fe4710678e
```

---

## Per omgeving: 3 stappen

Herhaal dit voor elke BC-omgeving waar wij toegang toe moeten hebben:

### Stap 1: Wissel naar de juiste omgeving

1. Open **Business Central** (https://businesscentral.dynamics.com)
2. Klik rechtsboven op het tandwiel en wissel naar de gewenste omgeving

### Stap 2: App registreren

1. Zoek via de zoekbalk naar: **Microsoft Entra-toepassingen** (of "Microsoft Entra Applications")
2. Klik op **+ Nieuw**
3. Vul in:
   - **Client-id:** `1690ac13-3f30-4482-b279-60fe4710678e`
   - **Beschrijving:** `Bratra Integratielaag`
   - **Status:** zet op **Geactiveerd**
4. Klik eventueel op **Toestemming geven** als dat gevraagd wordt

### Stap 3: Rechten toewijzen

1. Scroll naar **Gebruikersmachtigingensets** (onderaan de kaart)
2. Voeg toe:
   - `D365 BASIC`
   - `D365 BUS FULL ACCESS`
3. Bij **Bedrijf**: selecteer het juiste bedrijf (of laat leeg voor alle bedrijven in die omgeving)

Klaar.

---

## Wat ik van jou nodig heb per omgeving

Stuur mij na het instellen per omgeving de volgende gegevens:

| Gegeven | Waar te vinden | Voorbeeld |
|---------|----------------|-----------|
| **Omgevingsnaam** | Rechtsboven in BC naast het tandwiel, of via Instellingen > Beheer > Omgevingen | `Sandbox_POC_20251229` |
| **Bedrijfsnaam** | De naam van het bedrijf (company) in die omgeving | `BraTra PetProducts BV` |
| **Type** | Sandbox of Production | `Production` |

Dat is alles. De Tenant ID, het Client ID en het secret heb ik al -- die zijn voor alle omgevingen hetzelfde.

---

## Checklist

Vul onderstaande tabel in en stuur hem naar mij terug:

| Omgeving | Gedaan | Omgevingsnaam | Bedrijfsnaam | Type |
|----------|--------|---------------|--------------|------|
| Sandbox POC | Ja | `Sandbox_POC_20251229` | `20251229_POC_Bedrijf` | Sandbox |
| Productie Pet Products | [ ] | | | |
| Productie Non-Food | [ ] | | | |
| Productie Food | [ ] | | | |
| Overige: ... | [ ] | | | |

---

## Ter referentie

Dit is exact hetzelfde als wat je voor de POC hebt gedaan. Geen nieuw secret, geen Azure-wijzigingen. Alleen het registreren van dezelfde app in de andere BC-omgevingen.
