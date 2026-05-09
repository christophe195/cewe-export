# Project Guidelines

## Doel
CEWE `.mcfx` fotoboek-bestanden uitlezen en exporteren (bijv. naar PDF of afbeeldingen).

---

## MCFX Bestandsformaat

### Container
- Een `.mcfx` bestand is een **SQLite 3.x database** (application ID `0x43455745` = ASCII "CEWE").
- Eén tabel: `Files(Filename TEXT PRIMARY KEY, Data BLOB, LastModified INTEGER)`
- `LastModified` is Unix-tijd in **milliseconden**.

### Bestanden in de database
| Filename       | Inhoud |
|----------------|--------|
| `data.mcf`     | Hoofd-project XML (padded to 4 194 304 bytes = 4 MB) |
| `data.mcf~`    | Vorige versie van `data.mcf` (automatische backup) |
| `folderid.xml` | UUID-identifier van het project |
| `*.jpg` / `*.jpeg` / `*.png` / `*.svg` | Alle gebruikte foto's en assets |

### folderid.xml
```xml
<mcfkey folderID="<uuid>" padding="<padding>"/>
```
De `folderID` komt overeen met het `folderID`-attribuut in `data.mcf`.

### data.mcf — XML-structuur

**Root-element** `<fotobook>`:
- `art_id` — intern CEWE artikel-ID
- `article_name` — URL-encoded productnaam (bijv. `CEWE%20FOTOBOEK%20XL%20...`)
- `folderID` — UUID, zelfde als in `folderid.xml`
- `productname` — interne code (bijv. `ALB32`)
- `version` — formaat-versie (huidig: `4.0`)

**Directe kinderen van `<fotobook>`**:
- `<project>` — `projectID`, `createdWithHPSVersion`, build-datum
- `<savingVersion>` — `programversion`, `savetime`
- `<creationHistory>` — `clientId`, `creationDate`
- `<articleConfig>` — `normalpages`, `totalpages`, `pagenaming`, `panoStartScene`
- `<addOns>` — extra bestelde opties
- `<pagenumbering>` — stijl van paginanummering
- `<extra>` — laatste tekst-opmaak en kwaliteitsinstellingen
- `<page>` (meerdere) — de pagina's van het boek

### Pagina's (`<page>`)
Attributen: `pagenr`, `rotation`, `type`, `designStyleID`, `designStyleTemplateName`

**Page types**:
| type | betekenis |
|------|-----------|
| `fullcover` | Voor- of achtercover (inclusief rug) |
| `spine` | Rug apart |
| `normalpage` | Gewone boekpagina |
| `normalpage, panorama_base` | Basishelft van een panoramapagina |
| `normalpage, panorama_wing` | Vouwhelft van een panoramapagina |
| `emptypage` | Lege pagina |

**Paginaformaten** (`<bundlesize height="..." width="...">`), in tienden van millimeters:
| Formaat | width × height | = mm |
|---------|---------------|------|
| Normale pagina | 5800 × 2900 | 580 × 290 mm |
| Panorama | 11100 × 2900 | 1110 × 290 mm |
| Cover (full) | 6032 × 2960 | 603 × 296 mm |

### Gebieden (`<area>`)
Elk `<page>` bevat een of meer `<area>`-elementen.

**Area types**:
| areatype | beschrijving |
|----------|-------------|
| `imagearea` | Foto-kader |
| `imagebackgroundarea` | Achtergrondafbeelding van de pagina |
| `smartlayoutarea` | Auto-layout groep voor meerdere foto's |
| `textarea` | Tekstvak |
| `spinetextarea` | Tekst op de rug |
| `clipartarea` | Decoratie-element (clipart) |

**`<position>`** attributen (eenheden: tienden van mm):
`height`, `width`, `left`, `top`, `rotation` (graden), `zposition` (laagvolgorde)

**`<image>`** (in een `imagearea`):
- `filename="safecontainer:/<key>_<index>_<originele-bestandsnaam>"` — verwijst naar rij in `Files`-tabel
- `useABK` — 0 of 1 (alternativebooklet key-flag)
- Kind `<cutout left="..." top="..." scale="..."/>` — uitsnede en zoom
  - `scale` = **MCFX-eenheden per pixel** (bevestigd via meting: 1984px × 0.469 = 931 eenheden)
  - `left` / `top` = offset van de linkerbovenhoek van de afbeelding t.o.v. de linkerbovenhoek van het frame (in MCFX-eenheden, negatief = afbeelding steekt buiten frame uit)
  - Rendered breedte in pt = `pixelBreedte × scale × (72/254)`

**`<text>`** (in textarea / spinetextarea):
- CDATA-blok met **Qt rich text HTML** (HTML 4 subset)
- `areaTextType` — `content` of `spine`

### Afbeeldingsbestandsnamen in de DB
Patroon: `[8-teken-id]_[volgnummer]_[originele-bestandsnaam].[ext]`
- De 8-teken-id is de `safecontainer`-sleutel.
- Sommige afbeeldingen hebben twee versies (bv. `_1_` en `_2_`).
- Oudere CEWE-stijl: `XXXXXXXX_XXXXXXXX_XXXXXX_XXXXXN.jpg` (geen id-prefix).

### Software
Gemaakt met CEWE HPS (Home Photo Software) versie `8.0.5` (build `20251014`).

---

## Code Style
<!-- Taal- en opmaakvookeuren -->

## Conventions
<!-- Projectspecifieke patronen en afspraken -->
