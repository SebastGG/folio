# folio

Ein persönlicher, gewichteter Aktienindex als Web-App. Du stellst Körbe
(„Baskets“) aus Tickern und Stückzahlen zusammen, folio rechnet daraus einen
Index und zeigt ihn als Chart — daneben jeden Einzelwert, dein Depot und dein
übriges Vermögen.

## Was folio kann

- **Baskets & Index** — beliebig viele Körbe, Stückzahlen (negativ = Short),
  Umrechnung fremder Währungen, Aktiensplits werden erkannt und zurückgerechnet.
- **Charts** — Kerzen mit Wochen-/Monatsverdichtung, gleitende Durchschnitte,
  log. Regression, Volumenprofil, Zeichenwerkzeuge (Linien, Fibonacci, Gann,
  Pitchforks, …), Earnings-Termine und für Einzelaktien der Vergleich mit dem
  Sektor-ETF.
- **Interactive Brokers** — Positionen, Trades und Barbestand über die eigene
  Flex Query; Kauf und Verkauf erscheinen als Marker im Chart.
- **Konten & Vermögen** — Girokonten, weitere Depots (Bestand als CSV,
  Umsätze als CSV oder camt), Sachwerte und Darlehen, dazu eine Vermögenskurve.
- **Screener** — Finviz-Filter je Sektor, Treffer landen in eigenen Baskets;
  was man aussortiert, sperrt eine Blacklist für eine einstellbare Zeit.
- **Steuer** — aus IBKR-Exporten eine Aufstellung für die Anlage KAP / KAP-INV
  samt PDF (siehe Hinweis unten).
- **Protokoll** — was die App gerade tut, in zehn Detailstufen; daneben der
  Verlauf, mit dem sich hinzugefügte und entfernte Ticker zurücknehmen lassen.

Die Oberfläche ist deutsch. Es gibt eine Desktop- und eine Mobilansicht; eine
ausführliche Hilfe steckt in der App selbst.

## Lokal starten

Voraussetzung ist Python 3.10 oder neuer.

```bash
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8000
```

Dann <http://localhost:8000> öffnen. Ohne Anmeldedienst läuft folio mit einem
einzigen Benutzer; alle Daten liegen unter `./data` (anderer Ort über die
Umgebungsvariable `DATA_DIR`). Kurse holt folio beim **↻ Refresh** für alle
Ticker und beim Öffnen eines Einzelwerts für diesen einen.

## Auf Cloudron betreiben

`Dockerfile` und `CloudronManifest.json` liegen bei. Das Manifest nutzt das
OIDC-Addon: Jeder Cloudron-Benutzer meldet sich mit seinem Konto an und
bekommt ein eigenes Datenverzeichnis unter `/app/data/<benutzer>/`.

```bash
docker build -t <registry>/folio:latest . && docker push <registry>/folio:latest
cloudron install --image <registry>/folio:latest
```

`.woodpecker.yml` ist die Pipeline, mit der das Original bei jedem Push auf
`main` baut und deployt — als Vorlage gedacht, sie braucht eigene Secrets
(`registry_user`, `registry_password`, `cloudron_token`) und eigene Hostnamen.

## Woher die Daten kommen

| Was | Quelle |
|---|---|
| Kurse, Stammdaten, Earnings, Tickersuche | Yahoo Finance (inoffizielle Schnittstelle, zeitverzögert) |
| Screener | Finviz |
| Depot, Trades | Interactive Brokers, Flex Query mit eigenem Token |
| Wechselkurse für die Steuer | Europäische Zentralbank |

Yahoo und Finviz sind keine offiziellen Datendienste; ihre Nutzungsbedingungen
gelten. folio fragt sparsam an: nur fehlende Tage, höchstens ein Abruf je
Ticker und Minute.

## Hinweis

folio ist ein privates Werkzeug, keine Anlage- und keine Steuerberatung. Die
Steuerseiten rechnen nach bestem Wissen, ohne Gewähr — vor der Abgabe prüfen.

## Lizenz

folio steht unter der **GNU Affero General Public License v3.0** (siehe
[`LICENSE`](LICENSE)). Wer folio verändert und anderen als Webdienst anbietet,
muss ihnen den geänderten Quellcode ebenfalls zugänglich machen.

Enthaltene Fremdbestandteile, jeweils mit eigener Lizenz:

- [`konvex_tax/`](konvex_tax/) — Steuer-Engine aus
  [KonvexInvestment/ibkr-steuer](https://github.com/KonvexInvestment/ibkr-steuer),
  MIT ([`konvex_tax/LICENSE`](konvex_tax/LICENSE))
- [`static/lib/lightweight-charts-drawing.umd.js`](static/lib/) — Zeichenwerkzeuge aus
  [deepentropy/lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing),
  MIT ([`static/lib/LICENSE.lightweight-charts-drawing`](static/lib/LICENSE.lightweight-charts-drawing))
- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) —
  wird zur Laufzeit von unpkg geladen, Apache-2.0
