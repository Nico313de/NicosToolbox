// ==UserScript==
// @name         NicoToolbox
// @namespace    NicoToolbox
// @version      1.13.1
// @description  NicoToolbox mit allen Applets und Changelog in einer Datei.
// @author       Nico
// @match        https://game.rescue-operator.com/*
// @updateURL    https://nico313de.github.io/NicosToolbox/NicoToolbox.user.js
// @downloadURL  https://nico313de.github.io/NicosToolbox/NicoToolbox.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================
       Configuration
       ========================================================= */

    const DB_NAME = 'NicoToolboxDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'settings';
    const SCRIPT_NAME = 'NicoToolbox';
    const SCRIPT_VERSION = '1.13.1';
    const CHANGELOG_STORE_KEY = 'lastSeenVersion';
    const CHANGELOG_APPLETS_KEY = 'lastSeenAppletVersions';
    const CHANGELOG_POPUP_ID = 'nicotoolbox-changelog-popup';
    const ENABLED_APPLETS_KEY = 'enabledApplets';
    const STORE_PANEL_ID = 'nicotoolbox-applet-store';
    const STORE_BUTTON_CLASS = 'nicotoolbox-store-button';

    /* Store und Applet-Icons liegen gemeinsam unter dem Toolbox-Button. */

    const TOOLBOX_BUTTON_CLASS = 'nicotoolbox-toolbox-button';
    const TOOLBOX_SLOT_CLASS = 'nicotoolbox-toolbox-slot';
    const TOOLBOX_SLOT_ITEM_WIDTH = 48;
    const TOOLBOX_SLOT_MAX_ITEMS = 5;

    /* =========================================================
       Runtime state
       ========================================================= */

    let db = null;

    let observer = null;
    let scanTimer = null;

    let toolboxExpanded = false;

    const appletRegistry = new Map();
    let appletStates = {};

    /* =========================================================
       IndexedDB
       ========================================================= */

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = event => {
                const database = event.target.result;

                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME);
                }
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    function dbGet(key) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                STORE_NAME,
                'readonly'
            );

            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(key);

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    function dbSet(key, value) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                STORE_NAME,
                'readwrite'
            );

            const store = transaction.objectStore(STORE_NAME);

            store.put(value, key);

            transaction.oncomplete = () => {
                resolve();
            };

            transaction.onerror = () => {
                reject(transaction.error);
            };
        });
    }

    /* =========================================================
       Utility
       ========================================================= */

    function normalizeName(name) {
        return String(name || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
    }

    function getAAOKey(name) {
        return normalizeName(name);
    }

    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function createID(prefix = 'id') {
        return `${prefix}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}`;
    }

    function compareVersions(left, right) {
        const leftParts = String(left)
            .split('.')
            .map(part => Number.parseInt(part, 10) || 0);

        const rightParts = String(right)
            .split('.')
            .map(part => Number.parseInt(part, 10) || 0);

        const length = Math.max(
            leftParts.length,
            rightParts.length
        );

        for (let index = 0; index < length; index += 1) {
            const difference =
                (leftParts[index] || 0) -
                (rightParts[index] || 0);

            if (difference !== 0) {
                return difference;
            }
        }

        return 0;
    }

    /* =========================================================
       Applet context (public API for applets)
       ========================================================= */

    const appletContext = {
        dbGet,
        dbSet,
        escapeHTML,
        normalizeName,
        getAAOKey,
        createID,
        getAppletSlot,
        mountAppletButton
    };

    /* =========================================================
       Applet registry
       ========================================================= */

    function registerApplet(applet) {
        if (
            !applet ||
            typeof applet.id !== 'string' ||
            appletRegistry.has(applet.id)
        ) {
            return;
        }

        appletRegistry.set(applet.id, applet);
    }

    /* =========================================================
       Applet states
       ========================================================= */

    async function loadAppletStates() {
        const stored = await dbGet(ENABLED_APPLETS_KEY);

        if (
            stored &&
            typeof stored === 'object' &&
            !Array.isArray(stored)
        ) {
            appletStates = stored;
        }
    }

    function isAppletEnabled(id) {
        return appletStates[id] !== false;
    }

    async function setAppletEnabled(id, enabled) {
        appletStates[id] = !!enabled;

        await dbSet(ENABLED_APPLETS_KEY, appletStates);
    }

    async function runAppletInit(applet) {
        if (typeof applet.init !== 'function') {
            return;
        }

        try {
            await applet.init(appletContext);
        } catch (error) {
            console.error(
                '[NicoToolbox] Applet init failed:',
                applet.id,
                error
            );
        }
    }

    async function runAppletDispose(applet) {
        if (typeof applet.dispose !== 'function') {
            return;
        }

        try {
            await applet.dispose(appletContext);
        } catch (error) {
            console.error(
                '[NicoToolbox] Applet dispose failed:',
                applet.id,
                error
            );
        }
    }

    async function initEnabledApplets() {
        for (const applet of appletRegistry.values()) {
            if (!isAppletEnabled(applet.id)) {
                continue;
            }

            await runAppletInit(applet);
        }
    }

    async function toggleApplet(id, enabled) {
        await setAppletEnabled(id, enabled);

        const applet = appletRegistry.get(id);

        if (!applet) {
            return;
        }

        if (enabled) {
            await runAppletInit(applet);

            if (typeof applet.onScan === 'function') {
                try {
                    applet.onScan(appletContext);
                } catch (error) {
                    console.error(
                        '[NicoToolbox] Applet scan failed:',
                        applet.id,
                        error
                    );
                }
            }
        } else {
            await runAppletDispose(applet);
        }

        /* Ein- und Ausschalten ändert die Zahl der Icons
           im aufklappbaren Slot. */

        scheduleScan();
    }

    /* Eingebettetes Änderungsprotokoll; keine Netzwerkabfragen. */
    async function loadChangelogData() {
        return {
    "toolbox": {
        "1.12.0": [
            "Technik: Applets werden nun in einem Icon zusammengefasst welche ausfahren wenn man darauf klickt."
        ],
        "1.11.0": [
            "Technik: Das Changelog wird jetzt nicht mehr im Kernskript mitgeliefert, sondern aus der changelog.json geladen. Das Skript bleibt dadurch klein, auch wenn das Changelog weiter wächst.",
            "Neu: Applets haben jetzt eigene Versionshinweise. Updates von Applets erscheinen ebenfalls in diesem Popup – auch wenn die Toolbox selbst nicht aktualisiert werden musste."
        ],
        "1.10.2": [
            "Ergänzung der Header Informationen im Kernskript."
        ],
        "1.10.1": [
            "Technik: Applets werden jetzt über ein Manifest geladen. Applet-Updates erscheinen automatisch, ohne dass die Toolbox selbst aktualisiert werden muss."
        ],
        "1.10.0": [
            "NEU: Applet Store – Über den neuen Knopf in der Schnellzugriffsleiste kannst du selbst wählen, welche Funktionen der Toolbox aktiv sind.",
            "Technik: Die Funktionen sind jetzt in eigene Module (Applets) aufgeteilt und können einzeln aktiviert oder deaktiviert werden. Genau wie bei Cogs eines Discord-Bots."
        ],
        "1.9.0": [
            "Entfernt: Die Funktionen „Fahrzeugliste“ (Kilometerstände) und „Bettenauslastung“, diese Funktionen bleiben deaktiviert bzw. entfernt bis zum Public API Release."
        ],
        "1.8.3": [
            "Krankenhaus-Bettenauslastung: Bugfix – Die Anzeige wird jetzt automatisch alle 60 Sekunden aktualisiert, auch ohne das Stations-Panel zu öffnen. (Der Poll ruft jetzt die Stationsdaten statt der Sitzungsdaten ab.)"
        ],
        "1.8.2": [
            "AAO-Kategorien: AAOs lassen sich jetzt frei per Drag & Drop sortieren (an der Griffleiste „⋮⋮“ ziehen), anstatt zwangsweise alphabetisch sortiert zu werden. Die Reihenfolge gilt auch in der Fahrzeug-Alarmierung und wird gespeichert."
        ],
        "1.8.1": [
            "Krankenhaus-Bettenauslastung: Bugfix – Die Anzeige der Bettenauslastung wird jetzt korrekt aktualisiert, wenn sich die Bettenanzahl ändert. (Fetched alle 60sec die Daten neu.)"
        ],
        "1.8.0": [
            "Neue Anzeige „Bettenauslastung“ in der Statusleiste oben rechts: zeigt belegte und maximale Betten aller Krankenhäuser sowie die Auslastung in Prozent.",
            "Die Auslastung wird automatisch aus den Spieldaten ausgelesen und pro Spiel lokal zwischengespeichert."
        ],
        "1.7.5": [
            "Bugfix: Kilometerstände und Fahrzeugdaten werden jetzt getrennt pro Spiel gespeichert. Einträge aus anderen Spielen werden ignoriert und nicht mehr versucht abzurufen (Endete in einem Cacheloop mit Websocket Fehlern)."
        ],
        "1.7.4": [
            "Fahrzeugliste: Ein neuer Aktualisieren-Knopf lädt die Kilometerstände aller Fahrzeuge sofort neu."
        ],
        "1.7.3": [
            "Fahrzeugliste: Fahrzeuge mit mehr als 30.000 gefahrenen Kilometern erhalten ein Warnsymbol neben dem Kilometerstand.",
            "Ein Klick auf das Warnsymbol öffnet einen Hinweis zur erhöhten Laufleistung und möglichen Reparaturkosten."
        ],
        "1.7.2": [
            "Fahrzeugliste: Die Fortschrittsanzeige beim Laden der Kilometerstände verschwindet nach dem Laden automatisch.",
            "Fahrzeugliste: Kilometerstände werden robuster aus der API gelesen; fehlgeschlagene Abrufe werden angezeigt."
        ],
        "1.7.0": [
            "Fahrzeugliste: Der gefahrene Kilometerstand wird automatisch für alle Fahrzeuge geladen und neben jedem Fahrzeug angezeigt.",
            "Neuer Schalter „Nach km sortieren“ sortiert die Fahrzeugliste nach gefahrenen Kilometern (absteigend).",
            "Fahrzeugdaten werden lokal zwischengespeichert, damit nicht bei jedem Öffnen erneut alle Daten geladen werden."
        ],
        "1.6.0": [
            "Neuer Notizblock in der rechten Leiste – Notizen werden automatisch lokal gespeichert.",
            "Nach einem Update erscheint dieses Popup mit den Neuerungen der neuen Version."
        ]
    },
    "applets": {
        "aaoCategories": {
            "1.0.3": [
                "AAO-Kategorien: Bugfix – Es konnte vorkommen, dass die Kategorien gar nicht erst angezeigt wurden. Die AAO-Liste wird jetzt an ihrem Inhalt erkannt statt an technischen Attributen des Spiels, die sich geändert haben. Dadurch funktionieren die Kategorien wieder unabhängig davon, ob eine oder mehrere AAOs angelegt sind.",
                "Das Kategorie-Panel wird jetzt als eigenständiger Bereich neben der AAO-Liste eingefügt und blendet diese nur noch aus. Vorher konnte es dadurch selbst mit ausgeblendet werden."
            ],
            "1.0.2": [
                "Unter bestimmten Umständen konnte es vorkommen, dass die AAO-Kategorien nicht korrekt geladen wurden. Zum Beispiel in einem neuen Spiel, in dem noch keine AAOs gespeichert waren."
            ],
            "1.0.1": [
                "AAOs lassen sich jetzt frei per Drag & Drop sortieren (an der Griffleiste „⋮⋮“ ziehen), anstatt zwangsweise alphabetisch sortiert zu werden. Die Reihenfolge gilt auch in der Fahrzeug-Alarmierung und wird gespeichert."
            ],
            "1.0.0": [
                "Erste Version: Sortiert AAOs in eigene Kategorien und ersetzt die AAO-Auswahl im Alarmierungsfenster durch eine kategorisierte Ansicht."
            ]
        },
        "notepad": {
            "1.0.0": [
                "Erste Version: Fügt einen Notizblock zu den Schnelltasten hinzu. Notizen werden automatisch lokal gespeichert."
            ]
        },
        "fmsAlert": {
            "1.1.0": [
                "Neu: Bei einem Sprechwunsch erscheint direkt unter der Statusleiste im Seitenkopf ein rot pulsierender Balken mit dem Hinweis „Sprechwunsch!“. Dieser visuelle Hinweis bleibt immer sichtbar.",
            ],
            "1.0.1": [
            ],
            "1.0.0": [
            ]
        },
        "mapDarkmode": {
            "1.0.0": [
                "Erste Version: Blendet die Karte auf Wunsch ab. Das Sonne/Mond-Icon in der Toolbox schaltet zwischen dunkler und heller Karte um.",
                "Die Einstellung wird lokal gespeichert und bleibt deshalb auch nach einem Neuladen des Spiels erhalten."
            ]
        }
    }
};
    }

    function pickNewerNotes(source, lastSeenVersion) {
        return Object.keys(source || {})
            .filter(version => {
                return (
                    compareVersions(version, lastSeenVersion) > 0 &&
                    Array.isArray(source[version]) &&
                    source[version].length > 0
                );
            })
            .sort((left, right) => compareVersions(right, left))
            .map(version => ({
                version,
                notes: source[version].map(note => String(note))
            }));
    }

    function collectAppletChangelog(data, seenApplets) {
        const entries = [];

        for (const applet of appletRegistry.values()) {
            const notes = pickNewerNotes(
                (data || {})[applet.id],
                seenApplets[applet.id] || '0'
            );

            if (notes.length === 0) {
                continue;
            }

            entries.push({
                id: applet.id,
                name: applet.name || applet.id,
                version: applet.version || '',
                notes
            });
        }

        return entries;
    }

    function markAppletsAsSeen(seenApplets) {
        const next = {
            ...seenApplets
        };

        for (const applet of appletRegistry.values()) {
            if (typeof applet.version === 'string' && applet.version) {
                next[applet.id] = applet.version;
            }
        }

        return next;
    }

    async function showChangelogPopup() {
        const data = await loadChangelogData();

        if (!data || typeof data !== 'object') {
            return;
        }

        const lastSeenVersion =
            (await dbGet(CHANGELOG_STORE_KEY)) || '';

        const seenApplets =
            (await dbGet(CHANGELOG_APPLETS_KEY)) || {};

        const toolboxEntries = pickNewerNotes(
            data.toolbox,
            lastSeenVersion
        );

        const appletEntries = collectAppletChangelog(
            data.applets,
            seenApplets
        );

        if (toolboxEntries.length === 0 && appletEntries.length === 0) {
            return;
        }

        renderChangelogPopup(toolboxEntries, appletEntries);

        await dbSet(CHANGELOG_STORE_KEY, SCRIPT_VERSION);
        await dbSet(
            CHANGELOG_APPLETS_KEY,
            markAppletsAsSeen(seenApplets)
        );
    }

    function renderChangelogPopup(toolboxEntries, appletEntries) {
        if (document.getElementById(CHANGELOG_POPUP_ID)) {
            return;
        }

        const toolboxSection = toolboxEntries.map(entry => `
            <div class="nicotoolbox-changelog-version">
                <div class="nicotoolbox-changelog-version-title">
                    Version ${escapeHTML(entry.version)}
                </div>

                <ul class="nicotoolbox-changelog-list">
                    ${entry.notes.map(note => `
                        <li>${escapeHTML(note)}</li>
                    `).join('')}
                </ul>
            </div>
        `).join('');

        const appletSection = appletEntries.length === 0
            ? ''
            : `
                <div class="nicotoolbox-changelog-section-title">
                    Applet-Updates
                </div>

                ${appletEntries.map(entry => `
                    <div class="nicotoolbox-changelog-applet">
                        <div class="nicotoolbox-changelog-applet-head">
                            <span class="nicotoolbox-changelog-applet-name">
                                <i class="fa-solid fa-shapes"></i>
                                ${escapeHTML(entry.name)}
                            </span>

                            ${
                                entry.version
                                    ? `
                                        <span class="nicotoolbox-changelog-applet-version">
                                            v${escapeHTML(entry.version)}
                                        </span>
                                    `
                                    : ''
                            }
                        </div>

                        ${entry.notes.map(note => `
                            <div class="nicotoolbox-changelog-version-title">
                                Version ${escapeHTML(note.version)}
                            </div>

                            <ul class="nicotoolbox-changelog-list">
                                ${note.notes.map(line => `
                                    <li>${escapeHTML(line)}</li>
                                `).join('')}
                            </ul>
                        `).join('')}
                    </div>
                `).join('')}
            `;

        const overlay = document.createElement('div');

        overlay.id = CHANGELOG_POPUP_ID;
        overlay.className = 'nicotoolbox-changelog-overlay';

        overlay.innerHTML = `
            <div class="nicotoolbox-changelog-popup">
                <div class="nicotoolbox-changelog-popup-header">
                    <div class="nicotoolbox-changelog-popup-title">
                        Update installiert – Was ist neu?
                    </div>

                    <button
                        type="button"
                        class="nicotoolbox-changelog-popup-close"
                        title="Schließen"
                    >
                        ×
                    </button>
                </div>

                <div class="nicotoolbox-changelog-popup-body">
                    ${toolboxSection}
                    ${appletSection}
                </div>
            </div>
        `;

        let keydownHandler = null;

        const close = () => {
            overlay.remove();

            if (keydownHandler) {
                document.removeEventListener(
                    'keydown',
                    keydownHandler
                );
            }
        };

        overlay
            .querySelector(
                '.nicotoolbox-changelog-popup-close'
            )
            .addEventListener(
                'click',
                event => {
                    event.preventDefault();
                    event.stopPropagation();

                    close();
                }
            );

        overlay.addEventListener(
            'click',
            event => {
                if (event.target === overlay) {
                    close();
                }
            }
        );

        keydownHandler = event => {
            if (event.key === 'Escape') {
                close();
            }
        };

        document.addEventListener('keydown', keydownHandler);

        document.body.appendChild(overlay);
    }

    /* =========================================================
       Applet Store UI
       ========================================================= */

    function findQuickAccessRail() {
        return document.getElementById('nicotoolbox-header-tools');
    }

    function positionToolbox() {
        const host = findQuickAccessRail();
        if (!host) return;
        // Am Coins-Symbol orientieren, unabhängig vom aktuellen Kontostand.
        const icons = document.querySelectorAll('.fa-coins, [data-icon="coins"]');
        let anchor = null;
        for (const icon of icons) {
            const rect = icon.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top < 120 && rect.left < window.innerWidth / 2) {
                anchor = icon.closest('button, a, [role="button"]') || icon.parentElement;
                break;
            }
        }
        if (!anchor) {
            if (!host.hidden) host.hidden = true;
            return;
        }
        // Nur die Position übernehmen. Die Toolbox darf nicht innerhalb
        // des Coins-Kaufbereichs liegen und dessen Klick auslösen.
        if (host.parentElement !== document.body) document.body.appendChild(host);
        const rect = anchor.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.right + 10, window.innerWidth - 48)) + 'px';
        const top = Math.max(8, rect.top) + 'px';
        if (host.style.left !== left) host.style.left = left;
        if (host.style.top !== top) host.style.top = top;
        if (host.hidden) host.hidden = false;
    }

    function createStoreButton() {
        const button = document.createElement('button');

        button.type = 'button';

        button.className =
            `${STORE_BUTTON_CLASS} w-10 h-10 sm:w-10 sm:h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 hover:border-gray-700 transition-all duration-300 flex items-center justify-center cursor-pointer`;

        button.title = 'Applet Store öffnen';

        button.innerHTML =
            '<i class="fa-solid fa-puzzle-piece text-sm sm:text-sm text-white/80"></i>';

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            openStorePanel();
        });

        return button;
    }

    function hookStoreButton() {
        const slot = getAppletSlot();
        if (slot && !slot.querySelector('.' + STORE_BUTTON_CLASS)) {
            slot.prepend(createStoreButton());
        }
    }


    /* =========================================================
       Toolbox-Button und aufklappbarer Applet-Slot
       ========================================================= */

    function getToolboxButton() {
        const container = findQuickAccessRail();

        if (!container) {
            return null;
        }

        return container.querySelector(
            `.${TOOLBOX_BUTTON_CLASS}`
        );
    }

    function getAppletSlot() {
        const container = findQuickAccessRail();

        if (!container) {
            return null;
        }

        return container.querySelector(
            `.${TOOLBOX_SLOT_CLASS}`
        );
    }

    function createToolboxButton() {
        const button = document.createElement('button');

        button.type = 'button';

        button.className =
            `${TOOLBOX_BUTTON_CLASS} w-10 h-10 sm:w-10 sm:h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 hover:border-gray-700 transition-all duration-300 flex items-center justify-center cursor-pointer`;

        button.title =
            'Toolbox-Applets ein-/ausklappen';

        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-expanded', 'false');

        button.innerHTML =
            '<i class="fa-solid fa-toolbox text-sm sm:text-sm text-white/80"></i>';

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            toggleToolboxSlot();
        });

        return button;
    }

    function createToolboxSlot() {
        const slot = document.createElement('div');

        slot.className =
            `${TOOLBOX_SLOT_CLASS} flex flex-row items-center gap-2`;

        return slot;
    }

    /* Der Slot bekommt seine Breite aus der Anzahl der eingehangten
       Icons, damit die Animation unabhängig von der Applet-Anzahl
       gleich schnell läuft. Ohne Icons bleibt er zu. */

    function getToolboxSlotWidth(slot) {
        const count = slot.querySelectorAll(
            ':scope > *'
        ).length;

        if (count === 0) {
            return 0;
        }

        const visible = Math.min(
            count,
            TOOLBOX_SLOT_MAX_ITEMS
        );

        const buttons = [...slot.children].slice(0, visible);
        return buttons.reduce((sum, button) => sum + (button.offsetWidth || 40), 0)
            + Math.max(0, buttons.length - 1) * 8;
    }

    function syncToolboxSlot() {
        const slot = getAppletSlot();

        if (!slot) {
            return;
        }

        const width = getToolboxSlotWidth(slot);

        const isOpen = toolboxExpanded && width > 0;

        slot.classList.toggle(
            'nicotoolbox-toolbox-open',
            isOpen
        );

        /* Nur schreiben, wenn sich der Wert ändert. Sonst meldet
           der MutationObserver den eigenen Scan als Änderung. */

        const host = findQuickAccessRail();
        const availableWidth = Math.max(0, window.innerWidth - host.getBoundingClientRect().right - 16);
        const maxWidth = isOpen ? Math.min(width, availableWidth) + 'px' : '0px';
        if (slot.style.maxWidth !== maxWidth) {
            slot.style.maxWidth = maxWidth;
        }

        const button = getToolboxButton();

        if (!button) {
            return;
        }

        button.setAttribute(
            'aria-expanded',
            isOpen ? 'true' : 'false'
        );

        button.classList.toggle(
            'nicotoolbox-toolbox-open',
            isOpen
        );
    }

    function setToolboxExpanded(expanded) {
        toolboxExpanded = !!expanded;

        syncToolboxSlot();
    }

    function toggleToolboxSlot() {
        setToolboxExpanded(!toolboxExpanded);
    }

    /* Alle Applet-Schaltflächen werden unter dem Store eingehängt. */
    function mountAppletButton(button) {
        const slot = getAppletSlot();
        if (!slot) return null;
        slot.appendChild(button);
        syncToolboxSlot();
        return slot;
    }

    let toolboxOrder = [];
    const sortableButtons = new WeakSet();
    let toolboxDrag = null;
    function toolboxKey(button) {
        return [...button.classList].find(name => name.startsWith('nicotoolbox-') && name.endsWith('-button')) || '';
    }
    function persistToolboxOrder() {
        const visible = [...getAppletSlot().children].map(toolboxKey).filter(Boolean);
        const remaining = [...visible];
        toolboxOrder = toolboxOrder.map(key => visible.includes(key) ? remaining.shift() : key).filter(Boolean);
        toolboxOrder.push(...remaining);
        dbSet('toolboxIconOrder', toolboxOrder).catch(error => console.error('[NicoToolbox] Icon-Reihenfolge konnte nicht gespeichert werden:', error));
    }
    function reorderToolbox() {
        const slot = getAppletSlot();
        if (!slot || toolboxDrag) return;
        const buttons = [...slot.children];
        const rank = button => { const index = toolboxOrder.indexOf(toolboxKey(button)); return index < 0 ? toolboxOrder.length : index; };
        const sorted = [...buttons].sort((a, b) => rank(a) - rank(b));
        sorted.forEach((button, index) => { if (slot.children[index] !== button) slot.insertBefore(button, slot.children[index] || null); });
        for (const button of buttons) {
            if (sortableButtons.has(button)) continue;
            sortableButtons.add(button);
            button.style.touchAction = 'none';
            button.setAttribute('aria-description', 'Zum Sortieren ziehen oder Alt und Pfeiltaste links/rechts drücken.');
            let suppressClickUntil = 0;
            button.addEventListener('click', event => {
                if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
            }, true);
            button.addEventListener('pointerdown', event => {
                if (event.button !== 0 || toolboxDrag) return;
                toolboxDrag = { button, x: event.clientX, y: event.clientY, moved: false, pointer: event.pointerId };
                button.setPointerCapture(event.pointerId);
            });
            button.addEventListener('pointermove', event => {
                if (toolboxDrag?.button !== button || toolboxDrag.pointer !== event.pointerId) return;
                if (Math.hypot(event.clientX - toolboxDrag.x, event.clientY - toolboxDrag.y) > 6) {
                    toolboxDrag.moved = true; button.style.opacity = '0.5';
                }
            });
            function finish(event, cancel = false) {
                if (toolboxDrag?.button !== button) return;
                const moved = toolboxDrag.moved;
                toolboxDrag = null; button.style.opacity = '';
                if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
                if (!moved) return;
                suppressClickUntil = Date.now() + 500;
                if (cancel) return;
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('button');
                if (target && target !== button && target.parentElement === slot) {
                    const bounds = target.getBoundingClientRect();
                    slot.insertBefore(button, event.clientX < bounds.left + bounds.width / 2 ? target : target.nextSibling);
                    persistToolboxOrder();
                }
            }
            button.addEventListener('pointerup', event => finish(event));
            button.addEventListener('pointercancel', event => finish(event, true));
            button.addEventListener('lostpointercapture', event => finish(event, true));
            button.addEventListener('keydown', event => {
                if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const target = event.key === 'ArrowLeft' ? button.previousElementSibling : button.nextElementSibling;
                if (!target) return;
                slot.insertBefore(button, event.key === 'ArrowLeft' ? target : target.nextSibling);
                persistToolboxOrder(); button.focus();
            });
        }
    }

    function hookToolboxButton() {
        let host = findQuickAccessRail();
        if (!host) {
            host = document.createElement('div');
            host.id = 'nicotoolbox-header-tools';
            host.hidden = true;
            host.append(createToolboxButton(), createToolboxSlot());
            document.body.appendChild(host);
        }
        positionToolbox();
    }

    function closeStorePanel() {
        const overlay = document.getElementById(STORE_PANEL_ID);

        if (overlay) {
            overlay.remove();
        }
    }

    function openStorePanel() {
        if (document.getElementById(STORE_PANEL_ID)) {
            return;
        }

        const overlay = document.createElement('div');

        overlay.id = STORE_PANEL_ID;
        overlay.className = 'nicotoolbox-store-overlay';

        overlay.innerHTML = `
            <div class="nicotoolbox-store-panel">
                <div class="nicotoolbox-store-header">
                    <div>
                        <div class="nicotoolbox-store-title">
                            Applet Store
                        </div>

                        <div class="nicotoolbox-store-subtitle">
                            Wähle, welche Funktionen der Toolbox aktiv sein sollen.
                        </div>
                    </div>

                    <button
                        type="button"
                        class="nicotoolbox-store-close"
                        title="Schließen"
                    >
                        ×
                    </button>
                </div>

                <div class="nicotoolbox-store-body">
                    ${renderAppletRows()}
                </div>

                <div class="nicotoolbox-store-footer">
                    Änderungen werden sofort übernommen.
                </div>
            </div>
        `;

        let keydownHandler = null;

        const close = () => {
            overlay.remove();

            if (keydownHandler) {
                document.removeEventListener('keydown', keydownHandler);
            }
        };

        overlay.querySelector('.nicotoolbox-store-close')
            .addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                close();
            });

        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                close();
            }
        });

        keydownHandler = event => {
            if (event.key === 'Escape') {
                close();
            }
        };

        document.addEventListener('keydown', keydownHandler);

        document.body.appendChild(overlay);

        bindStoreToggles();
    }

    function renderAppletRows() {
        if (appletRegistry.size === 0) {
            return `
                <div class="nicotoolbox-store-empty">
                    Keine Applets verfügbar.
                </div>
            `;
        }

        return Array.from(appletRegistry.values()).map(applet => {
            const enabled = isAppletEnabled(applet.id);

            const version = applet.version
                ? `v${escapeHTML(String(applet.version))}`
                : '';

            return `
                <div class="nicotoolbox-store-applet" data-applet-id="${escapeHTML(applet.id)}">
                    <div class="nicotoolbox-store-applet-icon">
                        <i class="fa-solid fa-shapes"></i>
                    </div>

                    <div class="nicotoolbox-store-applet-info">
                        <div class="nicotoolbox-store-applet-name">
                            ${escapeHTML(applet.name)}

                            ${version ? `<span class="nicotoolbox-store-applet-version">${version}</span>` : ''}
                        </div>

                        <div class="nicotoolbox-store-applet-desc">
                            ${escapeHTML(applet.description || '')}
                        </div>
                    </div>

                    <label class="nicotoolbox-store-switch">
                        <input
                            type="checkbox"
                            ${enabled ? 'checked' : ''}
                        >
                        <span class="nicotoolbox-store-switch-slider"></span>
                    </label>
                </div>
            `;
        }).join('');
    }

    function bindStoreToggles() {
        const overlay = document.getElementById(STORE_PANEL_ID);

        if (!overlay) {
            return;
        }

        overlay.querySelectorAll('.nicotoolbox-store-applet').forEach(row => {
            const id = row.dataset.appletId;

            const input = row.querySelector('input[type="checkbox"]');

            if (!id || !input) {
                return;
            }

            input.addEventListener('change', async () => {
                const enabled = input.checked;

                await toggleApplet(id, enabled);
            });
        });
    }

    /* =========================================================
       CSS
       ========================================================= */

    function injectStyles() {
        if (document.getElementById('nicotoolbox-toolbox-core-styles')) {
            return;
        }

        const style = document.createElement('style');

        style.id = 'nicotoolbox-toolbox-core-styles';

        style.textContent = `
            .nicotoolbox-game-rail {
                top: 50% !important;
                bottom: auto !important;
                height: max-content !important;
                transform: translateY(-50%) !important;
            }
            .nicotoolbox-game-rail > .h-20 { display: none; }
            #nicotoolbox-header-tools {
                position: fixed;
                z-index: auto;
                width: 40px;
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            #nicotoolbox-header-tools[hidden] { display: none; }
            #nicotoolbox-header-tools > .nicotoolbox-toolbox-slot {
                position: absolute;
                top: 0;
                left: 48px;
                width: max-content;
                height: 40px;
                flex-direction: row;
                gap: 8px;
            }
            #nicotoolbox-header-tools button { flex-shrink: 0; }

            .nicotoolbox-update-notice {
                position: fixed;
                top: 16px;
                right: 16px;
                z-index: 99999;
                display: flex;
                align-items: center;
                gap: 12px;
                max-width: min(560px, calc(100vw - 32px));
                padding: 12px 14px;
                border: 1px solid #fecaca;
                border-radius: 10px;
                background: #fff7f7;
                box-shadow: 0 8px 24px rgba(17, 24, 39, 0.16);
                color: #7f1d1d;
                font-size: 13px;
            }

            .nicotoolbox-update-notice-content {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
            }

            .nicotoolbox-update-notice-link {
                flex-shrink: 0;
                padding: 7px 10px;
                border-radius: 7px;
                background: #dc2626;
                color: white;
                font-weight: 600;
                text-decoration: none;
            }

            .nicotoolbox-update-notice-link:hover {
                background: #b91c1c;
            }

            .nicotoolbox-update-notice-close {
                flex-shrink: 0;
                width: 28px;
                height: 28px;
                border: 0;
                border-radius: 6px;
                background: transparent;
                color: #991b1b;
                cursor: pointer;
                font-size: 20px;
                line-height: 1;
            }

            .nicotoolbox-update-notice-close:hover {
                background: #fee2e2;
            }

            .nicotoolbox-changelog-overlay {
                position: fixed;
                inset: 0;
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                background: rgba(17, 24, 39, 0.45);
            }

            .nicotoolbox-changelog-popup {
                width: min(520px, 100%);
                max-height: 70vh;
                display: flex;
                flex-direction: column;
                border: 1px solid #e5e7eb;
                border-radius: 14px;
                background: #ffffff;
                box-shadow: 0 20px 50px rgba(17, 24, 39, 0.35);
                overflow: hidden;
            }

            .nicotoolbox-changelog-popup-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 14px 16px;
                background: #f9fafb;
                border-bottom: 1px solid #e5e7eb;
            }

            .nicotoolbox-changelog-popup-title {
                font-size: 16px;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-changelog-popup-close {
                width: 30px;
                height: 30px;
                border: 0;
                border-radius: 8px;
                background: transparent;
                color: #6b7280;
                cursor: pointer;
                font-size: 20px;
                line-height: 1;
            }

            .nicotoolbox-changelog-popup-close:hover {
                background: #e5e7eb;
                color: #111827;
            }

            .nicotoolbox-changelog-popup-body {
                padding: 16px;
                overflow-y: auto;
            }

            .nicotoolbox-changelog-version + .nicotoolbox-changelog-version {
                margin-top: 16px;
            }

            .nicotoolbox-changelog-section-title {
                margin-top: 20px;
                margin-bottom: 10px;
                padding-top: 14px;
                border-top: 1px solid #e5e7eb;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: #6b7280;
            }

            .nicotoolbox-changelog-applet {
                padding: 12px;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                background: #f9fafb;
            }

            .nicotoolbox-changelog-applet + .nicotoolbox-changelog-applet {
                margin-top: 10px;
            }

            .nicotoolbox-changelog-applet-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 8px;
            }

            .nicotoolbox-changelog-applet-name {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
                font-size: 14px;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-changelog-applet-version {
                flex: 0 0 auto;
                padding: 2px 8px;
                border-radius: 999px;
                background: #e5e7eb;
                color: #374151;
                font-size: 11px;
                font-weight: 700;
            }

            .nicotoolbox-changelog-applet .nicotoolbox-changelog-version-title {
                color: #6b7280;
                font-size: 12px;
            }

            .nicotoolbox-changelog-applet .nicotoolbox-changelog-version-title + .nicotoolbox-changelog-list {
                margin-bottom: 8px;
            }

            .nicotoolbox-changelog-applet .nicotoolbox-changelog-list:last-child {
                margin-bottom: 0;
            }

            .nicotoolbox-changelog-version-title {
                margin-bottom: 6px;
                font-size: 14px;
                font-weight: 700;
                color: #dc2626;
            }

            .nicotoolbox-changelog-list {
                margin: 0;
                padding-left: 20px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                color: #374151;
                font-size: 13px;
                line-height: 1.5;
            }

            /* =====================================================
               Aufklappbarer Applet-Slot
               ===================================================== */

            .nicotoolbox-toolbox-slot {
                flex-shrink: 0;
                overflow-x: auto;
                overflow-y: hidden;
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                scrollbar-width: none;
                transition:
                    max-width 240ms ease,
                    opacity 160ms ease,
                    visibility 0s linear 240ms;
            }

            .nicotoolbox-toolbox-slot.nicotoolbox-toolbox-open {
                opacity: 1;
                visibility: visible;
                pointer-events: auto;
                transition:
                    max-width 240ms ease,
                    opacity 160ms ease,
                    visibility 0s linear 0s;
            }

            .nicotoolbox-toolbox-slot::-webkit-scrollbar {
                display: none;
            }

            /* Offen bleibt nur die Umrandung des Icons, damit sich
               der aktive Zustand vom Store-Button abhebt. */

            .nicotoolbox-toolbox-button.nicotoolbox-toolbox-open {
                border-color: rgba(99, 102, 241, 0.85);
            }

            /* =====================================================
               Applet Store
               ===================================================== */

            .nicotoolbox-store-overlay {
                position: fixed;
                inset: 0;
                z-index: 99999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                background: rgba(17, 24, 39, 0.45);
            }

            .nicotoolbox-store-panel {
                width: min(560px, 100%);
                max-height: 78vh;
                display: flex;
                flex-direction: column;
                border: 1px solid #e5e7eb;
                border-radius: 14px;
                background: #ffffff;
                box-shadow: 0 20px 50px rgba(17, 24, 39, 0.35);
                overflow: hidden;
            }

            .nicotoolbox-store-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 14px 16px;
                background: #f9fafb;
                border-bottom: 1px solid #e5e7eb;
            }

            .nicotoolbox-store-title {
                font-size: 16px;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-store-subtitle {
                margin-top: 2px;
                font-size: 12px;
                color: #6b7280;
            }

            .nicotoolbox-store-close {
                width: 30px;
                height: 30px;
                border: 0;
                border-radius: 8px;
                background: transparent;
                color: #6b7280;
                cursor: pointer;
                font-size: 20px;
                line-height: 1;
            }

            .nicotoolbox-store-close:hover {
                background: #e5e7eb;
                color: #111827;
            }

            .nicotoolbox-store-body {
                padding: 16px;
                overflow-y: auto;
            }

            .nicotoolbox-store-empty {
                padding: 20px;
                text-align: center;
                color: #6b7280;
                font-size: 13px;
            }

            .nicotoolbox-store-applet {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
            }

            .nicotoolbox-store-applet + .nicotoolbox-store-applet {
                margin-top: 10px;
            }

            .nicotoolbox-store-applet-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                width: 40px;
                height: 40px;
                border-radius: 10px;
                background: #eef2ff;
                color: #6366f1;
                font-size: 16px;
            }

            .nicotoolbox-store-applet-info {
                flex: 1;
                min-width: 0;
            }

            .nicotoolbox-store-applet-name {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 14px;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-store-applet-version {
                padding: 2px 7px;
                border-radius: 999px;
                background: #f3f4f6;
                color: #6b7280;
                font-size: 11px;
                font-weight: 600;
            }

            .nicotoolbox-store-applet-desc {
                margin-top: 3px;
                font-size: 12px;
                color: #6b7280;
                line-height: 1.4;
            }

            .nicotoolbox-store-switch {
                position: relative;
                flex-shrink: 0;
                width: 42px;
                height: 24px;
                cursor: pointer;
            }

            .nicotoolbox-store-switch input {
                position: absolute;
                opacity: 0;
                width: 0;
                height: 0;
            }

            .nicotoolbox-store-switch-slider {
                position: absolute;
                inset: 0;
                border-radius: 999px;
                background: #d1d5db;
                transition: background 120ms ease;
            }

            .nicotoolbox-store-switch-slider::before {
                position: absolute;
                content: '';
                width: 18px;
                height: 18px;
                top: 3px;
                left: 3px;
                border-radius: 50%;
                background: #ffffff;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
                transition: transform 120ms ease;
            }

            .nicotoolbox-store-switch input:checked
            + .nicotoolbox-store-switch-slider {
                background: #ef4444;
            }

            .nicotoolbox-store-switch input:checked
            + .nicotoolbox-store-switch-slider::before {
                transform: translateX(18px);
            }

            .nicotoolbox-store-switch input:focus-visible
            + .nicotoolbox-store-switch-slider {
                outline: 2px solid #ef4444;
                outline-offset: 2px;
            }

            .nicotoolbox-store-footer {
                padding: 10px 16px;
                border-top: 1px solid #e5e7eb;
                background: #f9fafb;
                color: #6b7280;
                font-size: 12px;
                text-align: center;
            }
        `;

        document.head.appendChild(style);
    }

    /* =========================================================
       Main scanning
       ========================================================= */

    function centerGameQuickAccess() {
        const icon = document.querySelector('i.fa-light-emergency-on');
        const rail = icon?.closest('div.absolute.flex.flex-col');
        if (rail && !rail.classList.contains('nicotoolbox-game-rail')) {
            rail.classList.add('nicotoolbox-game-rail');
        }
    }

    function scan() {
        centerGameQuickAccess();
        hookToolboxButton();
        hookStoreButton();

        for (const applet of appletRegistry.values()) {
            if (
                !isAppletEnabled(applet.id) ||
                typeof applet.onScan !== 'function'
            ) {
                continue;
            }

            try {
                applet.onScan(appletContext);
            } catch (error) {
                console.error(
                    '[NicoToolbox] Applet scan failed:',
                    applet.id,
                    error
                );
            }
        }

        reorderToolbox();

        /* Erst nach den Applets: sie hängen ihre Icons in den
           Slot, dessen Breite danach berechnet wird. */

        syncToolboxSlot();
    }

    function scheduleScan() {
        if (scanTimer) {
            clearTimeout(scanTimer);
        }

        scanTimer = setTimeout(() => {
            scanTimer = null;

            try {
                scan();
            } catch (error) {
                console.error(
                    '[NicoToolbox] Scan failed:',
                    error
                );
            }
        }, 100);
    }

    /* =========================================================
       MutationObserver
       ========================================================= */

    function startObserver() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver(mutations => {
            let relevant = false;

            for (const mutation of mutations) {
                if (
                    mutation.type === 'childList' ||
                    mutation.type === 'attributes'
                ) {
                    relevant = true;
                    break;
                }
            }

            if (relevant) {
                scheduleScan();
            }
        });

        observer.observe(
            document.body,
            {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: [
                    'class',
                    'style',
                    'data-state'
                ]
            }
        );
    }

    /* =========================================================
       Initialization
       ========================================================= */

    async function initialize() {
        try {
            db = await openDatabase();

            injectStyles();

            await loadAppletStates();
            const savedOrder = await dbGet('toolboxIconOrder');
            if (Array.isArray(savedOrder)) toolboxOrder = [...new Set(savedOrder.filter(key => typeof key === 'string'))];

            // Alle Applets sind bereits in dieser Datei registriert.

            await initEnabledApplets();

            scan();

            startObserver();
            window.addEventListener('resize', scheduleScan);
            window.addEventListener('scroll', scheduleScan, { passive: true });

            showChangelogPopup();

            console.info(
                '[NicoToolbox] initialized.'
            );
        } catch (error) {
            console.error(
                '[NicoToolbox] initialization failed:',
                error
            );
        }
    }

    /* Lokal eingebettete Applets.  */
/* =========================================================
   NicoToolbox – Applet: AAO-Kategorien
   Wird als @require vom Kernskript geladen und registriert
   sich selbst in der globalen Applet-Warteschlange.
   ========================================================= */

(function () {
    'use strict';

    const AAO_SETTINGS_PANEL_ID = 'nicotoolbox-aao-category-panel';
    const AAO_DISPATCH_PANEL_ID = 'nicotoolbox-aao-dispatch-panel';
    const UNCATEGORIZED_ORDER_KEY = 'aaoUncategorizedOrder';
    const STYLES_ID = 'nicotoolbox-applet-aao-styles';

    const DEFAULT_CATEGORIES = [
        {
            id: 'fire',
            name: 'Brandbekämpfung',
            collapsed: false
        },
        {
            id: 'technical',
            name: 'Technische Hilfe',
            collapsed: false
        },
        {
            id: 'medical',
            name: 'Rettungsdienst',
            collapsed: false
        }
    ];

    let api = null;

    let categories = [];
    let assignments = {};

    const aaoCatalog = new Map();
    const selectedAAOs = new Set();
    const originalAAORows = new Map();

    let lastDispatchContainer = null;
    let lastSettingsSection = null;

    let dispatchSearchValue = '';
    let draggedCategoryID = null;
    let draggedAAOKey = null;
    let uncategorizedAAOOrder = [];

    /* =========================================================
       Styles
       ========================================================= */

    function injectStyles() {
        if (document.getElementById(STYLES_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLES_ID;

        style.textContent = `
            #${AAO_SETTINGS_PANEL_ID} {
                position: relative;
                z-index: 10;
                width: 100%;
                margin-bottom: 12px;
            }

            .nicotoolbox-settings-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 12px 14px;
                margin-bottom: 10px;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                background: #ffffff;
            }

            .nicotoolbox-settings-title {
                font-size: 18px;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-settings-subtitle {
                margin-top: 2px;
                font-size: 12px;
                color: #6b7280;
            }

            .nicotoolbox-add-category {
                border: 0;
                border-radius: 8px;
                padding: 8px 12px;
                background: #ef4444;
                color: white;
                font-weight: 600;
                cursor: pointer;
            }

            .nicotoolbox-add-category:hover {
                background: #dc2626;
            }

            .nicotoolbox-settings-empty-hint {
                margin-bottom: 10px;
                padding: 10px 14px;
                border: 1px dashed #d1d5db;
                border-radius: 12px;
                background: #f9fafb;
                font-size: 12px;
                color: #6b7280;
            }

            .nicotoolbox-settings-category {
                margin-bottom: 10px;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                overflow: hidden;
                background: white;
            }

            .nicotoolbox-settings-category-header {
                display: flex;
                align-items: center;
                gap: 8px;
                min-height: 46px;
                padding: 8px 12px;
                background: #f9fafb;
                border-bottom: 1px solid #e5e7eb;
            }

            .nicotoolbox-category-collapse {
                width: 28px;
                height: 28px;
                border: 0;
                background: transparent;
                cursor: pointer;
                color: #6b7280;
            }

            .nicotoolbox-category-drag-handle {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 28px;
                color: #9ca3af;
                cursor: grab;
                font-size: 16px;
                letter-spacing: 0;
                user-select: none;
            }

            .nicotoolbox-category-drag-handle:hover {
                color: #4b5563;
            }

            .nicotoolbox-category-drag-handle:active {
                cursor: grabbing;
            }

            .nicotoolbox-category-dragging {
                opacity: 0.55;
            }

            .nicotoolbox-category-drop-target {
                border-color: #ef4444;
                box-shadow: 0 0 0 2px #fee2e2;
            }

            .nicotoolbox-category-name {
                flex: 1;
                font-weight: 700;
                color: #111827;
            }

            .nicotoolbox-category-actions {
                display: flex;
                gap: 4px;
            }

            .nicotoolbox-category-actions button {
                width: 30px;
                height: 30px;
                border: 0;
                border-radius: 7px;
                background: transparent;
                cursor: pointer;
                color: #6b7280;
            }

            .nicotoolbox-category-actions button:hover {
                background: #e5e7eb;
                color: #111827;
            }

            .nicotoolbox-category-actions button:disabled {
                opacity: 0.35;
                cursor: default;
            }

            .nicotoolbox-category-actions button:disabled:hover {
                background: transparent;
                color: #6b7280;
            }

            .nicotoolbox-category-delete:hover {
                color: #dc2626 !important;
                background: #fee2e2 !important;
            }

            .nicotoolbox-settings-category-content {
                padding: 8px;
            }

            .nicotoolbox-settings-aao-row {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 9px 10px;
                border-radius: 9px;
            }

            .nicotoolbox-settings-aao-row:hover {
                background: #f9fafb;
            }

            .nicotoolbox-settings-aao-info {
                flex: 1;
                min-width: 0;
            }

            .nicotoolbox-settings-aao-name {
                font-size: 14px;
                font-weight: 600;
                color: #111827;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .nicotoolbox-settings-aao-summary {
                margin-top: 2px;
                font-size: 11px;
                font-family: monospace;
                color: #6b7280;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .nicotoolbox-settings-aao-select {
                min-width: 170px;
                max-width: 230px;
                height: 34px;
                padding: 0 8px;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                background: white;
                color: #111827;
                cursor: pointer;
            }

            .nicotoolbox-settings-edit {
                width: 34px;
                height: 34px;
                flex-shrink: 0;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                background: white;
                cursor: pointer;
            }

            .nicotoolbox-settings-edit:hover {
                background: #f3f4f6;
            }

            .nicotoolbox-settings-delete {
                width: 34px;
                height: 34px;
                flex-shrink: 0;
                border: 1px solid #fecaca;
                border-radius: 8px;
                background: white;
                color: #dc2626;
                cursor: pointer;
            }

            .nicotoolbox-settings-delete:hover {
                background: #fee2e2;
            }

            .nicotoolbox-aao-drag-handle {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                width: 20px;
                height: 28px;
                color: #9ca3af;
                cursor: grab;
                font-size: 16px;
                letter-spacing: 0;
                user-select: none;
            }

            .nicotoolbox-aao-drag-handle:hover {
                color: #4b5563;
            }

            .nicotoolbox-aao-drag-handle:active {
                cursor: grabbing;
            }

            .nicotoolbox-aao-dragging {
                opacity: 0.55;
            }

            .nicotoolbox-aao-drop-target {
                border-color: #ef4444;
                box-shadow: 0 0 0 2px #fee2e2;
            }

            #${AAO_DISPATCH_PANEL_ID} {
                width: 100%;
                padding-bottom: 6px;
            }

            .nicotoolbox-dispatch-category {
                margin-bottom: 8px;
            }

            .nicotoolbox-dispatch-category-header {
                width: 100%;
                min-height: 42px;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                border: 1px solid #e5e7eb;
                border-radius: 10px;
                background: #f9fafb;
                color: #111827;
                cursor: pointer;
                text-align: left;
            }

            .nicotoolbox-dispatch-category-header:hover {
                background: #f3f4f6;
            }

            .nicotoolbox-dispatch-category-arrow {
                width: 18px;
                flex-shrink: 0;
                color: #6b7280;
                font-size: 11px;
            }

            .nicotoolbox-dispatch-category-name {
                flex: 1;
                font-weight: 700;
                font-size: 14px;
            }

            .nicotoolbox-dispatch-category-count {
                min-width: 24px;
                padding: 2px 7px;
                border-radius: 999px;
                background: #e5e7eb;
                color: #4b5563;
                font-size: 11px;
                font-weight: 700;
                text-align: center;
            }

            .nicotoolbox-dispatch-category-content {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding-top: 8px;
            }

            .nicotoolbox-dispatch-category-content
            > [data-nicotoolbox-aao-key] {
                min-height: 60px;
            }

            .nicotoolbox-dispatch-category-content
            > [data-nicotoolbox-aao-key]:hover {
                border-color: #fca5a5 !important;
            }

            .nicotoolbox-dispatch-uncategorized {
                cursor: default;
            }

            .nicotoolbox-dispatch-uncategorized:hover {
                background: #f9fafb;
            }

            .nicotoolbox-aao-selected {
                border-color: #ef4444 !important;
                background-color: #fef2f2 !important;
            }

            .nicotoolbox-aao-dispatch-item {
                user-select: none;
                -webkit-user-select: none;
            }

            .nicotoolbox-aao-dispatch-item:focus-visible {
                outline: 2px solid #ef4444;
                outline-offset: 2px;
            }

            .nicotoolbox-aao-dispatch-item:hover {
                transform: translateY(-1px);
            }

            @media (max-width: 640px) {
                .nicotoolbox-settings-aao-row {
                    flex-wrap: wrap;
                }

                .nicotoolbox-settings-aao-info {
                    width: 100%;
                    flex-basis: 100%;
                }

                .nicotoolbox-settings-aao-select {
                    flex: 1;
                    min-width: 0;
                    max-width: none;
                }
            }
        `;

        document.head.appendChild(style);
    }

    /* =========================================================
       Load / save
       ========================================================= */

    async function loadData() {
        categories = await api.dbGet('categories');

        if (!Array.isArray(categories) || categories.length === 0) {
            categories = DEFAULT_CATEGORIES.map(category => ({
                ...category
            }));

            await api.dbSet('categories', categories);
        }

        assignments = await api.dbGet('assignments') || {};

        uncategorizedAAOOrder = await api.dbGet(
            UNCATEGORIZED_ORDER_KEY
        );

        if (!Array.isArray(uncategorizedAAOOrder)) {
            uncategorizedAAOOrder = [];
        }
    }

    async function saveCategories() {
        await api.dbSet('categories', categories);
    }

    async function saveAssignments() {
        await api.dbSet('assignments', assignments);
    }

    async function saveUncategorizedAAOOrder() {
        await api.dbSet(
            UNCATEGORIZED_ORDER_KEY,
            uncategorizedAAOOrder
        );
    }

    /* =========================================================
       Category helpers
       ========================================================= */

    function findCategory(categoryID) {
        return categories.find(
            category => category.id === categoryID
        );
    }

    function getCategoryForAAO(key) {
        const categoryID = assignments[key];

        if (!categoryID) {
            return null;
        }

        return findCategory(categoryID) || null;
    }

    async function moveCategoryBefore(categoryID, targetCategoryID) {
        const sourceIndex = categories.findIndex(
            category => category.id === categoryID
        );

        const targetIndex = categories.findIndex(
            category => category.id === targetCategoryID
        );

        if (
            sourceIndex < 0 ||
            targetIndex < 0 ||
            sourceIndex === targetIndex
        ) {
            return;
        }

        const [category] = categories.splice(sourceIndex, 1);

        const adjustedTargetIndex =
            sourceIndex < targetIndex
                ? targetIndex - 1
                : targetIndex;

        categories.splice(adjustedTargetIndex, 0, category);

        await saveCategories();

        renderSettingsPanel();
        renderDispatchPanel();
    }

    /* =========================================================
       AAO discovery
       ========================================================= */

    /* -----------------------------------------------------
       Eine AAO-Zeile wird an ihren Bestandteilen erkannt, nicht
       am Ziehgriff.

       Das Spiel rendert bei einer einzigen AAO eine schlichte
       Zeile: kein „data-slot", keine id, kein Griff. Erst ab
       zwei AAOs erscheint die sortierbare Zeile mit dem Griff
       „AAO verschieben". Eine Erkennung am Griff sieht deshalb
       bei genau einer AAO keine Liste – und räumt dann den
       Katalog, als gäbe es keine AAO.

       In beiden Gestaltungen vorhanden sind dagegen der Name
       („span.font-semibold"), die Kurzbeschreibung
       („span.font-mono") sowie die beiden Aktionen: ein Stift
       („button[data-slot=button]") und der Löschdialog
       („button[data-slot=alert-dialog-trigger]"). Das
       Formular „Neue AAO" hat keine dieser Aktionen und wird
       deshalb nicht als Zeile gelesen.
       ----------------------------------------------------- */

    const SETTINGS_ROW_EDIT_SELECTOR = 'button[data-slot="button"]';
    const SETTINGS_ROW_DELETE_SELECTOR =
        'button[data-slot="alert-dialog-trigger"]';

    /* -----------------------------------------------------
       Eine Zeile wird an ihren Bestandteilen erkannt: Name
       („span.font-semibold"), Kurzbeschreibung
       („span.font-mono") und die beiden Aktionen (Stift und
       Löschdialog). Das ist in beiden vom Spiel gerenderten
       Zeilengestaltungen vorhanden – unabhaengig davon, ob der
       Ziehgriff da ist oder nicht.

       Das Formular „Neue AAO" hat diese Aktionen nicht und wird
       deshalb nie als Zeile gelesen.
       ----------------------------------------------------- */

    function isAAORow(element) {
        if (!element || !element.matches('div')) {
            return false;
        }

        if (element.querySelector(`#${AAO_SETTINGS_PANEL_ID}`)) {
            return false;
        }

        if (!element.querySelector('span.font-semibold')) {
            return false;
        }

        if (!element.querySelector('span.font-mono')) {
            return false;
        }

        if (!element.querySelector(SETTINGS_ROW_EDIT_SELECTOR)) {
            return false;
        }

        return !!element.querySelector(
            SETTINGS_ROW_DELETE_SELECTOR
        );
    }

    /* -----------------------------------------------------
       Der Container wird nicht mehr an einem data-slot
       festgemacht – der hat sich in der aktuellen Fassung des
       Spiels geaendert und ist derzeit gar nicht mehr vorhanden.
       Gesucht wird die Liste als gemeinsamer Elternknoten der
       erkannten Zeilen. Das gilt fuer beide Zeilengestaltungen
       und haengt nicht an Klassen oder Attributen der Liste.
       ----------------------------------------------------- */

    function getSettingsAAORows() {
        /* Die Suche bleibt auf dem Abschnitt der Einstellungen.
           Das Spiel öffnet Fenster nebeneinander; eine ähnlich
           aufgebaute Liste in einem anderen Fenster gehört nicht
           zu diesem Applet. */

        const scope = findSettingsAAOSection() || document;

        const candidates = Array.from(
            scope.querySelectorAll('div')
        ).filter(isAAORow);

        if (candidates.length === 0) {
            return [];
        }

        /* Die inhaltliche Pruefung sieht auch uebergeordnete
           Knoten: der Listencontainer, der die Zeilen umschliesst,
           erfuellt sie ebenso, weil er Name, Beschreibung und
           Aktionen seiner Zeilen enthält. Eine Zeile ist deshalb
           nur, was selbst keine weitere Zeile enthält. Das
           grenzt die Zeilen zugleich von ihrem Container ab. */

        return candidates.filter(candidate => {
            return !candidates.some(other => {
                return other !== candidate &&
                    candidate.contains(other);
            });
        });
    }

    function findSettingsAAOContainer() {
        const rows = getSettingsAAORows();

        return rows.length > 0 ? rows[0].parentElement : null;
    }

    function findSettingsDialog() {
        const dialogs = Array.from(
            document.querySelectorAll(
                '[role="dialog"][data-slot="sheet-content"]'
            )
        );

        return dialogs.find(dialog => {
            return Array.from(dialog.querySelectorAll('h2')).some(h2 => {
                return h2.textContent.trim() === 'Einstellungen';
            });
        }) || null;
    }

    /* -----------------------------------------------------
       Anker für das Kategorien-Panel.

       Die native AAO-Liste existiert nur, wenn mindestens
       eine AAO angelegt wurde. In einem neuen Spiel
       rendert das Spiel stattdessen nur den Button
       „Neue AAO anlegen" und die sortierbare Liste fehlt
       komplett. Der Abschnitt mit der Überschrift
       „Alarm- und Ausrückeordnung" existiert dagegen
       immer und taugt daher als stabiler Anker.
       ----------------------------------------------------- */

    function findSettingsAAOSection() {
        const dialog = findSettingsDialog();

        if (!dialog) {
            return null;
        }

        const heading = Array.from(
            dialog.querySelectorAll('h3')
        ).find(h3 => {
            return h3.textContent.trim() ===
                'Alarm- und Ausrückeordnung';
        });

        if (!heading) {
            return null;
        }

        return heading.closest('div.space-y-4') || null;
    }

    function findDispatchDialog() {
        const dialogs = Array.from(
            document.querySelectorAll(
                '[role="dialog"][data-slot="sheet-content"]'
            )
        );

        return dialogs.find(dialog => {
            const search = dialog.querySelector(
                'input[placeholder="AAO suchen..."], input[placeholder="Suchen..."]'
            );

            if (!search) {
                return false;
            }

            return Array.from(dialog.querySelectorAll('h2'))
                .some(h2 => {
                    return h2.textContent.trim() ===
                        'Fahrzeuge alarmieren';
                });
        }) || null;
    }

    function findDispatchLists(dialog) {
        if (!dialog) {
            return [];
        }

        const searchInput = dialog.querySelector(
            'input[placeholder="AAO suchen..."], input[placeholder="Suchen..."]'
        );

        if (!searchInput) {
            return [];
        }

        return Array.from(
            dialog.querySelectorAll('div.space-y-2')
        ).filter(container => {
            return getDispatchCards(container).length > 0;
        });
    }

    function findDispatchList(dialog) {
        return findDispatchLists(dialog)[0] || null;
    }

    function hasAAOCards(dialog) {
        if (!dialog) {
            return false;
        }

        return findDispatchLists(dialog).some(container => {
            return getDispatchCards(container).some(card => {
                return !!card.querySelector(
                    'div.font-semibold.text-sm.text-gray-900'
                );
            });
        });
    }

    function isDispatchAAOModeEnabled(dialog) {
        if (!dialog) {
            return false;
        }

        /* -----------------------------------------------------
           „Nach Wachen sortieren": Jede Karte ist ein Fahrzeug
           und wird per Drag-and-Drop alarmiert. In diesem Modus
           gibt es keine AAO-Kategorien.
           ----------------------------------------------------- */

        if (dialog.querySelector('[data-drag-vehicle-id]')) {
            return false;
        }

        const controls = Array.from(
            dialog.querySelectorAll(
                'button, [role="button"], [role="switch"], input[type="checkbox"]'
            )
        );

        const getLabel = control => (
            control.getAttribute('aria-label') ||
            control.getAttribute('title') ||
            control.textContent ||
            ''
        )
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const isAAOModeLabel = label =>
            /\baao[\s-]?modus\b|\baao[\s-]?mode\b/i.test(label);

        const isWatchSortLabel = label =>
            /\bnach[\s-]wachen?(?:[\s-]sortieren)?\b|\bwachen?[\s-]sortieren\b|\bsort(?:ed)?\s*by\s+(?:station|watch)\b/i.test(label);

        const isOff = control => {
            const state = control.getAttribute('data-state');
            const pressed = control.getAttribute('aria-pressed');
            const checked = control.getAttribute('aria-checked');

            return state === 'off' ||
                state === 'unchecked' ||
                pressed === 'false' ||
                checked === 'false' ||
                ('checked' in control && !control.checked);
        };

        const isOn = control => {
            if (isOff(control)) {
                return false;
            }

            const state = control.getAttribute('data-state');
            const pressed = control.getAttribute('aria-pressed');
            const checked = control.getAttribute('aria-checked');

            return state === 'on' ||
                state === 'checked' ||
                pressed === 'true' ||
                checked === 'true' ||
                ('checked' in control && control.checked);
        };

        /* „Nach Wachen sortieren" ist explizit aktiviert -> AAO-Modus aus. */
        for (const control of controls) {
            if (
                isWatchSortLabel(getLabel(control)) &&
                isOn(control)
            ) {
                return false;
            }
        }

        /* AAO-Modus-Umschalter vorhanden? */
        const aaoControl = controls.find(control => {
            return isAAOModeLabel(getLabel(control));
        });

        if (aaoControl) {
            return !isOff(aaoControl);
        }

        /* Kein eindeutiger Umschalter gefunden: Nur wenn die sichtbaren
           Karten tatsächlich AAO-Karten sind, AAO-Modus annehmen. */
        return hasAAOCards(dialog);
    }

    function removeDispatchPanel(dialog, list) {
        const panel = dialog && dialog.querySelector(
            `#${AAO_DISPATCH_PANEL_ID}`
        );

        if (panel) {
            panel.remove();
        }

        for (const candidate of findDispatchLists(dialog)) {
            candidate.style.display = '';
        }

        if (list) {
            list.style.display = '';
        }

        selectedAAOs.clear();
    }

    function getDispatchCards(container) {
        if (!container) {
            return [];
        }

        return Array.from(container.children).filter(child => {
            return child.matches('[data-slot="card"]') ||
                !!child.querySelector(
                    'div.font-semibold.text-sm.text-gray-900'
                );
        });
    }

    function discoverAAOs() {
        let changed = false;

        /* -----------------------------------------------------
           Settings AAOs
           ----------------------------------------------------- */

        const settingsRows = getSettingsAAORows();
        const settingsContainer = settingsRows.length > 0
            ? settingsRows[0].parentElement
            : null;

        if (settingsContainer) {
            const seenSettingsKeys = new Set();

            const rows = settingsRows;

            for (const row of rows) {
                const nameElement = row.querySelector(
                    'span.font-semibold'
                );

                if (!nameElement) {
                    continue;
                }

                const name = nameElement.textContent.trim();

                if (!name) {
                    continue;
                }

                const key = api.getAAOKey(name);
                seenSettingsKeys.add(key);

                const summaryElement = row.querySelector(
                    'span.font-mono'
                );

                const summary = summaryElement
                    ? summaryElement.textContent.trim()
                    : '';

                const existing = aaoCatalog.get(key);

                aaoCatalog.set(key, {
                    key,
                    name,
                    summary,
                    source: 'settings',
                    row
                });

                originalAAORows.set(key, row);

                if (
                    !existing ||
                    existing.name !== name ||
                    existing.summary !== summary
                ) {
                    changed = true;
                }
            }

            /* -----------------------------------------------------
               Eintraege entfernen, die nicht mehr in der Liste
               stehen. Die Zuordnung bleibt erhalten: sie ist der
               Wunsch des Spielers und nicht ableitbar aus dem,
               was das Spiel gerade anzeigt. Waere die Liste
               wegen einer Suche nur teilweise gefuellt, ginge
               sonst die Zuordnung einer gesuchten AAO verloren.
               ----------------------------------------------------- */

            for (const [key, aao] of aaoCatalog) {
                if (
                    aao.source === 'settings' &&
                    !seenSettingsKeys.has(key)
                ) {
                    aaoCatalog.delete(key);
                    originalAAORows.delete(key);
                    selectedAAOs.delete(key);

                    changed = true;
                }
            }
        }

        /* -----------------------------------------------------
           Kein Container gefunden heisst nicht, dass es keine
           AAO gibt: der Dialog kann geschlossen sein, ein
           anderer Reiter kann den Inhalt abgebaut haben, oder das
           Spiel baut die Liste gerade neu auf. Der Katalog
           bleibt deshalb unangetastet. Vorher wurde er hier
           geleert, und beim Wechsel auf eine einzige AAO – wo
           das Spiel eine Zeile ohne data-slot rendert – riss das
           jede Zuordnung mit.

           Eine wirklich geloeschte AAO verschwindet beim
           naechsten Lesen der Liste von selbst aus dem Katalog.
           ----------------------------------------------------- */

        /* -----------------------------------------------------
           Dispatch AAOs
           ----------------------------------------------------- */

        const dispatchDialog = findDispatchDialog();

        if (dispatchDialog && isDispatchAAOModeEnabled(dispatchDialog)) {
            const list = findDispatchList(dispatchDialog);

            if (list) {
                const cards = getDispatchCards(list);

                for (const card of cards) {
                    const nameElement = card.querySelector(
                        'div.font-semibold.text-sm.text-gray-900'
                    );

                    if (!nameElement) {
                        continue;
                    }

                    const name = nameElement.textContent.trim();

                    if (!name) {
                        continue;
                    }

                    const key = api.getAAOKey(name);

                    const summaryElement = card.querySelector(
                        'div.text-xs.text-gray-500.font-mono'
                    );

                    const summary = summaryElement
                        ? summaryElement.textContent.trim()
                        : '';

                    const existing = aaoCatalog.get(key);

                    aaoCatalog.set(key, {
                        key,
                        name,
                        summary,
                        source: 'dispatch',
                        row: card
                    });

                    originalAAORows.set(key, card);

                    if (
                        !existing ||
                        existing.name !== name ||
                        existing.summary !== summary
                    ) {
                        changed = true;
                    }
                }
            }
        }

        return changed;
    }

    /* =========================================================
       Dispatch selection
       ========================================================= */

    function isAAOSelected(key) {
        return selectedAAOs.has(key);
    }

    function setSelectedVisual(element, selected) {
        if (!element) {
            return;
        }

        const icon = element.querySelector('.nicotoolbox-aao-icon');

        const iconElement = element.querySelector('.nicotoolbox-aao-icon i');

        const name = element.querySelector('.nicotoolbox-aao-name');

        if (selected) {
            element.classList.add('nicotoolbox-aao-selected');

            element.setAttribute('aria-pressed', 'true');

            element.style.borderColor = '#ef4444';

            element.style.backgroundColor = '#fef2f2';

            element.style.boxShadow =
                '0 1px 2px rgba(239,68,68,0.12), 0 8px 20px -6px rgba(239,68,68,0.25)';

            if (icon) {
                icon.style.backgroundColor = '#fee2e2';
            }

            if (iconElement) {
                iconElement.style.color = '#ef4444';
            }

            if (name) {
                name.style.color = '#dc2626';
            }
        } else {
            element.classList.remove('nicotoolbox-aao-selected');

            element.setAttribute('aria-pressed', 'false');

            element.style.borderColor = '#e5e7eb';

            element.style.backgroundColor = '#ffffff';

            element.style.boxShadow =
                '0 1px 2px rgba(16,24,40,0.04), 0 8px 20px -6px rgba(16,24,40,0.16)';

            if (icon) {
                icon.style.backgroundColor = '#eff6ff';
            }

            if (iconElement) {
                iconElement.style.color = '#3b82f6';
            }

            if (name) {
                name.style.color = '#111827';
            }
        }
    }

    /* =========================================================
       Trigger native AAO
       ========================================================= */

    function triggerOriginalAAO(key) {
        let original = originalAAORows.get(key);

        /* -----------------------------------------------------
           Try current dispatch dialog first
           ----------------------------------------------------- */

        const dispatchDialog = findDispatchDialog();

        if (dispatchDialog) {
            const list = findDispatchList(dispatchDialog);

            if (list) {
                const cards = getDispatchCards(list);

                for (const card of cards) {
                    const nameElement = card.querySelector(
                        'div.font-semibold.text-sm.text-gray-900'
                    );

                    if (!nameElement) {
                        continue;
                    }

                    const name = nameElement.textContent.trim();

                    if (api.getAAOKey(name) === key) {
                        original = card;

                        originalAAORows.set(key, card);

                        break;
                    }
                }
            }
        }

        /* -----------------------------------------------------
           Fall back to settings AAO
           ----------------------------------------------------- */

        if (!original || !original.isConnected) {
            for (const row of getSettingsAAORows()) {
                const nameElement = row.querySelector(
                    'span.font-semibold'
                );

                if (!nameElement) {
                    continue;
                }

                if (
                    api.getAAOKey(
                        nameElement.textContent.trim()
                    ) === key
                ) {
                    original = row;

                    originalAAORows.set(key, row);

                    break;
                }
            }
        }

        /* -----------------------------------------------------
           Click native AAO
           ----------------------------------------------------- */

        if (original && typeof original.click === 'function') {
            original.click();

            return true;
        }

        console.warn(
            '[NicoToolbox] Could not find original AAO:',
            key
        );

        return false;
    }

    function toggleAAOSelection(key) {
        const currentlySelected = selectedAAOs.has(key);

        if (currentlySelected) {
            selectedAAOs.delete(key);
        } else {
            selectedAAOs.add(key);
        }

        updateAllDispatchItems();

        triggerOriginalAAO(key);

        setTimeout(() => {
            updateAllDispatchItems();
        }, 50);

        setTimeout(() => {
            updateAllDispatchItems();
        }, 150);

        setTimeout(() => {
            updateAllDispatchItems();
        }, 300);
    }

    /* =========================================================
       Dispatch category UI
       ========================================================= */

    function sortAAOs(aaos, order) {
        const ordering = Array.isArray(order) ? order : [];

        return aaos.slice().sort((left, right) => {
            const leftIndex = ordering.indexOf(left.key);
            const rightIndex = ordering.indexOf(right.key);

            const leftKnown = leftIndex !== -1;
            const rightKnown = rightIndex !== -1;

            if (leftKnown && rightKnown) {
                return leftIndex - rightIndex;
            }

            if (leftKnown) {
                return -1;
            }

            if (rightKnown) {
                return 1;
            }

            return 0;
        });
    }

    function syncAAOOrders() {
        let changed = false;

        for (const category of categories) {
            if (!Array.isArray(category.aaoOrder)) {
                category.aaoOrder = [];

                for (const key of aaoCatalog.keys()) {
                    if (assignments[key] === category.id) {
                        category.aaoOrder.push(key);
                    }
                }

                changed = true;
            } else {
                for (const key of aaoCatalog.keys()) {
                    if (
                        assignments[key] === category.id &&
                        !category.aaoOrder.includes(key)
                    ) {
                        category.aaoOrder.push(key);
                        changed = true;
                    }
                }
            }
        }

        if (!Array.isArray(uncategorizedAAOOrder)) {
            uncategorizedAAOOrder = [];
            changed = true;
        }

        for (const key of aaoCatalog.keys()) {
            if (
                !assignments[key] &&
                !uncategorizedAAOOrder.includes(key)
            ) {
                uncategorizedAAOOrder.push(key);
                changed = true;
            }
        }

        return changed;
    }

    function ensureAAOOrdersSynced() {
        if (!syncAAOOrders()) {
            return;
        }

        saveCategories().catch(console.error);
        saveUncategorizedAAOOrder().catch(console.error);
    }

    async function moveAAOBefore(sourceKey, targetKey) {
        if (
            !sourceKey ||
            !targetKey ||
            sourceKey === targetKey
        ) {
            return;
        }

        const sourceCategory = getCategoryForAAO(sourceKey);
        const targetCategory = getCategoryForAAO(targetKey);

        const sourceGroup = sourceCategory
            ? sourceCategory.id
            : '';

        const targetGroup = targetCategory
            ? targetCategory.id
            : '';

        if (sourceGroup !== targetGroup) {
            return;
        }

        let order;

        if (sourceGroup) {
            const category = findCategory(sourceGroup);

            if (!category) {
                return;
            }

            if (!Array.isArray(category.aaoOrder)) {
                category.aaoOrder = [];
            }

            order = category.aaoOrder;
        } else {
            order = uncategorizedAAOOrder;
        }

        const sourceIndex = order.indexOf(sourceKey);

        if (sourceIndex >= 0) {
            order.splice(sourceIndex, 1);
        }

        const adjustedTargetIndex = order.indexOf(targetKey);

        if (adjustedTargetIndex >= 0) {
            order.splice(adjustedTargetIndex, 0, sourceKey);
        } else {
            order.push(sourceKey);
        }

        await Promise.all([
            saveCategories(),
            saveUncategorizedAAOOrder()
        ]);

        renderSettingsPanel();
        renderDispatchPanel();
    }

    function getAAOsForCategory(categoryID) {
        const category = findCategory(categoryID);

        return sortAAOs(
            Array.from(aaoCatalog.values()).filter(aao => {
                return assignments[aao.key] === categoryID;
            }),
            category ? category.aaoOrder : []
        );
    }

    function getUncategorizedAAOs() {
        return sortAAOs(
            Array.from(aaoCatalog.values()).filter(aao => {
                return !getCategoryForAAO(aao.key);
            }),
            uncategorizedAAOOrder
        );
    }

    function createDispatchAAOElement(aao) {
        const selected = isAAOSelected(aao.key);

        const element = document.createElement('div');

        element.className =
            'nicotoolbox-aao-dispatch-item flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all';

        element.setAttribute('data-nicotoolbox-aao-key', aao.key);

        element.setAttribute('role', 'button');

        element.setAttribute('tabindex', '0');

        element.setAttribute(
            'aria-pressed',
            selected ? 'true' : 'false'
        );

        element.title = `AAO auswählen: ${aao.name}`;

        element.innerHTML = `
            <div
                class="nicotoolbox-aao-icon w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                style="background:${selected ? '#fee2e2' : '#eff6ff'}"
            >
                <i
                    class="fa-solid text-sm fa-shuffle"
                    style="color:${selected ? '#ef4444' : '#3b82f6'}"
                ></i>
            </div>

            <div class="flex-1 min-w-0">
                <div
                    class="nicotoolbox-aao-name font-semibold text-sm"
                    style="color:${selected ? '#dc2626' : '#111827'}"
                >
                    ${api.escapeHTML(aao.name)}
                </div>

                <div
                    class="text-xs text-gray-500 font-mono truncate"
                >
                    ${api.escapeHTML(aao.summary)}
                </div>
            </div>
        `;

        element.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            toggleAAOSelection(aao.key);
        });

        element.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();

                toggleAAOSelection(aao.key);
            }
        });

        setSelectedVisual(element, selected);

        return element;
    }

    function renderDispatchPanel() {
        const dialog = findDispatchDialog();

        if (!dialog) {
            return;
        }

        if (!isDispatchAAOModeEnabled(dialog)) {
            removeDispatchPanel(
                dialog,
                findDispatchList(dialog)
            );

            return;
        }

        const list = findDispatchList(dialog);

        if (!list) {
            return;
        }

        ensureAAOOrdersSynced();

        let panel = dialog.querySelector(
            `#${AAO_DISPATCH_PANEL_ID}`
        );

        if (!panel) {
            panel = document.createElement('div');

            panel.id = AAO_DISPATCH_PANEL_ID;

            panel.className = 'nicotoolbox-dispatch-panel';

            list.parentElement.insertBefore(panel, list);
        }

        list.style.display = 'none';

        panel.innerHTML = '';

        const search = dispatchSearchValue.trim().toLowerCase();

        const originalCatalog = Array.from(aaoCatalog.values());

        /* -----------------------------------------------------
           Categorized AAOs
           ----------------------------------------------------- */

        for (const category of categories) {
            const items = getAAOsForCategory(category.id).filter(aao => {
                if (!search) {
                    return true;
                }

                return (
                    aao.name.toLowerCase().includes(search) ||
                    aao.summary.toLowerCase().includes(search)
                );
            });

            if (items.length === 0) {
                continue;
            }

            const wrapper = document.createElement('div');

            wrapper.className = 'nicotoolbox-dispatch-category';

            const header = document.createElement('button');

            header.type = 'button';

            header.className = 'nicotoolbox-dispatch-category-header';

            header.innerHTML = `
                <span class="nicotoolbox-dispatch-category-arrow">
                    ${category.collapsed ? '▶' : '▼'}
                </span>

                <span class="nicotoolbox-dispatch-category-name">
                    ${api.escapeHTML(category.name)}
                </span>

                <span class="nicotoolbox-dispatch-category-count">
                    ${items.length}
                </span>
            `;

            const content = document.createElement('div');

            content.className = 'nicotoolbox-dispatch-category-content';

            if (category.collapsed) {
                content.style.display = 'none';
            }

            for (const aao of items) {
                content.appendChild(createDispatchAAOElement(aao));
            }

            header.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                category.collapsed = !category.collapsed;

                saveCategories().catch(console.error);

                renderDispatchPanel();
            });

            wrapper.appendChild(header);
            wrapper.appendChild(content);

            panel.appendChild(wrapper);
        }

        /* -----------------------------------------------------
           Uncategorized
           ----------------------------------------------------- */

        const uncategorized = sortAAOs(
            originalCatalog.filter(aao => {
                return !getCategoryForAAO(aao.key);
            }).filter(aao => {
                if (!search) {
                    return true;
                }

                return (
                    aao.name.toLowerCase().includes(search) ||
                    aao.summary.toLowerCase().includes(search)
                );
            }),
            uncategorizedAAOOrder
        );

        if (uncategorized.length > 0) {
            const wrapper = document.createElement('div');

            wrapper.className = 'nicotoolbox-dispatch-category';

            const header = document.createElement('div');

            header.className =
                'nicotoolbox-dispatch-category-header nicotoolbox-dispatch-uncategorized';

            header.innerHTML = `
                <span class="nicotoolbox-dispatch-category-arrow">
                    ▼
                </span>

                <span class="nicotoolbox-dispatch-category-name">
                    Nicht zugeordnet
                </span>

                <span class="nicotoolbox-dispatch-category-count">
                    ${uncategorized.length}
                </span>
            `;

            const content = document.createElement('div');

            content.className = 'nicotoolbox-dispatch-category-content';

            for (const aao of uncategorized) {
                content.appendChild(createDispatchAAOElement(aao));
            }

            wrapper.appendChild(header);
            wrapper.appendChild(content);

            panel.appendChild(wrapper);
        }

        updateAllDispatchItems();
    }

    function updateAllDispatchItems() {
        const panel = document.querySelector(
            `#${AAO_DISPATCH_PANEL_ID}`
        );

        if (!panel) {
            return;
        }

        panel.querySelectorAll('[data-nicotoolbox-aao-key]')
            .forEach(element => {
                const key = element.getAttribute('data-nicotoolbox-aao-key');

                if (!key) {
                    return;
                }

                setSelectedVisual(element, selectedAAOs.has(key));
            });
    }

    /* =========================================================
       Settings UI
       ========================================================= */

    function createSettingsPanel() {
        const panel = document.createElement('div');

        panel.id = AAO_SETTINGS_PANEL_ID;

        return panel;
    }

    function renderSettingsPanel() {
        const section = findSettingsAAOSection();

        if (!section) {
            return;
        }

        const container = findSettingsAAOContainer();

        /* -----------------------------------------------------
           Das Panel gehoert als Geschwister direkt unter den
           Abschnitt, nie in die native Liste hinein. Der Abschnitt
           ist der Knoten, der im Spiel stabil bleibt; die Liste
           darunter wird beim Aendern neu aufgebaut. Laege das
           Panel in der Liste, wuerde es bei jedem Neuaufbau mit
           verschwinden – und waere beim Ausblenden der Liste
           selbst unsichtbar.
           ----------------------------------------------------- */

        let panel = document.querySelector(
            `#${AAO_SETTINGS_PANEL_ID}`
        );

        if (!panel || panel.parentElement !== section) {
            panel?.remove();

            panel = createSettingsPanel();

            section.appendChild(panel);
        }

        if (container) {
            container.style.display = 'none';
        }

        ensureAAOOrdersSynced();

        panel.innerHTML = '';

        const header = document.createElement('div');

        header.className = 'nicotoolbox-settings-header';

        header.innerHTML = `
            <div>
                <div class="nicotoolbox-settings-title">
                    AAO Kategorien
                </div>

                <div class="nicotoolbox-settings-subtitle">
                    Ordne jede AAO einer Kategorie zu.
                </div>
            </div>

            <button
                type="button"
                class="nicotoolbox-add-category"
            >
                + Kategorie
            </button>
        `;

        panel.appendChild(header);

        header.querySelector('.nicotoolbox-add-category')
            .addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();

                const name = prompt('Name der neuen Kategorie:');

                if (!name || !name.trim()) {
                    return;
                }

                categories.push({
                    id: api.createID('category'),
                    name: name.trim(),
                    collapsed: false
                });

                await saveCategories();

                renderSettingsPanel();
                renderDispatchPanel();
            });

        /* -----------------------------------------------------
           Empty hint
           ----------------------------------------------------- */

        if (aaoCatalog.size === 0) {
            const hint = document.createElement('div');

            hint.className = 'nicotoolbox-settings-empty-hint';

            hint.textContent =
                'Noch keine AAO angelegt. Lege oben eine AAO an, ' +
                'um sie hier einer Kategorie zuzuordnen.';

            panel.appendChild(hint);
        }

        /* -----------------------------------------------------
           Categories
           ----------------------------------------------------- */

        for (const category of categories) {
            const section = document.createElement('div');

            section.className = 'nicotoolbox-settings-category';

            section.dataset.categoryID = category.id;

            const categoryHeader = document.createElement('div');

            categoryHeader.className = 'nicotoolbox-settings-category-header';

            categoryHeader.innerHTML = `
                <span
                    class="nicotoolbox-category-drag-handle"
                    draggable="true"
                    title="Kategorie verschieben"
                    aria-label="Kategorie verschieben"
                >
                    ⋮⋮
                </span>

                <button
                    type="button"
                    class="nicotoolbox-category-collapse"
                >
                    ${category.collapsed ? '▶' : '▼'}
                </button>

                <span class="nicotoolbox-category-name">
                    ${api.escapeHTML(category.name)}
                </span>

                <span class="nicotoolbox-category-actions">
                    <button
                        type="button"
                        class="nicotoolbox-category-rename"
                        title="Kategorie umbenennen"
                    >
                        ✎
                    </button>

                    <button
                        type="button"
                        class="nicotoolbox-category-delete"
                        title="Kategorie löschen"
                    >
                        ×
                    </button>
                </span>
            `;

            section.appendChild(categoryHeader);

            const dragHandle = categoryHeader.querySelector(
                '.nicotoolbox-category-drag-handle'
            );

            dragHandle.addEventListener('dragstart', event => {
                draggedCategoryID = category.id;
                section.classList.add('nicotoolbox-category-dragging');

                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', category.id);
            });

            dragHandle.addEventListener('dragend', () => {
                draggedCategoryID = null;

                document.querySelectorAll(
                    '.nicotoolbox-category-dragging, .nicotoolbox-category-drop-target'
                ).forEach(element => {
                    element.classList.remove(
                        'nicotoolbox-category-dragging',
                        'nicotoolbox-category-drop-target'
                    );
                });
            });

            section.addEventListener('dragover', event => {
                if (
                    !draggedCategoryID ||
                    draggedCategoryID === category.id
                ) {
                    return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';

                section.classList.add('nicotoolbox-category-drop-target');
            });

            section.addEventListener('dragleave', event => {
                if (
                    event.relatedTarget &&
                    section.contains(event.relatedTarget)
                ) {
                    return;
                }

                section.classList.remove('nicotoolbox-category-drop-target');
            });

            section.addEventListener('drop', async event => {
                event.preventDefault();

                const sourceCategoryID =
                    event.dataTransfer.getData('text/plain') ||
                    draggedCategoryID;

                section.classList.remove('nicotoolbox-category-drop-target');

                if (
                    !sourceCategoryID ||
                    sourceCategoryID === category.id
                ) {
                    return;
                }

                await moveCategoryBefore(sourceCategoryID, category.id);
            });

            const content = document.createElement('div');

            content.className = 'nicotoolbox-settings-category-content';

            if (category.collapsed) {
                content.style.display = 'none';
            }

            const aaos = sortAAOs(
                Array.from(aaoCatalog.values()).filter(aao => {
                    return assignments[aao.key] === category.id;
                }),
                category.aaoOrder
            );

            for (const aao of aaos) {
                content.appendChild(createSettingsAAORow(aao));
            }

            /* -------------------------------------------------
               Collapse
               ------------------------------------------------- */

            categoryHeader.querySelector('.nicotoolbox-category-collapse')
                .addEventListener('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    category.collapsed = !category.collapsed;

                    await saveCategories();

                    renderSettingsPanel();
                    renderDispatchPanel();
                });

            /* -------------------------------------------------
               Rename
               ------------------------------------------------- */

            categoryHeader.querySelector('.nicotoolbox-category-rename')
                .addEventListener('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    const newName = prompt(
                        'Neuer Kategoriename:',
                        category.name
                    );

                    if (!newName || !newName.trim()) {
                        return;
                    }

                    category.name = newName.trim();

                    await saveCategories();

                    renderSettingsPanel();
                    renderDispatchPanel();
                });

            /* -------------------------------------------------
               Delete
               ------------------------------------------------- */

            categoryHeader.querySelector('.nicotoolbox-category-delete')
                .addEventListener('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    const usedBy = Object.values(assignments).filter(
                        id => id === category.id
                    ).length;

                    const message =
                        usedBy > 0
                            ? `Die Kategorie "${category.name}" enthält ${usedBy} AAO(s).\n\nDiese AAOs werden anschließend nicht zugeordnet sein.\n\nKategorie löschen?`
                            : `Kategorie "${category.name}" löschen?`;

                    if (!confirm(message)) {
                        return;
                    }

                    for (const key of Object.keys(assignments)) {
                        if (assignments[key] === category.id) {
                            delete assignments[key];
                        }
                    }

                    categories = categories.filter(
                        item => item.id !== category.id
                    );

                    await saveCategories();
                    await saveAssignments();

                    renderSettingsPanel();
                    renderDispatchPanel();
                });

            section.appendChild(content);
            panel.appendChild(section);
        }

        /* -----------------------------------------------------
           Uncategorized
           ----------------------------------------------------- */

        const uncategorized = getUncategorizedAAOs();

        if (uncategorized.length > 0) {
            const section = document.createElement('div');

            section.className =
                'nicotoolbox-settings-category nicotoolbox-uncategorized';

            const headerElement = document.createElement('div');

            headerElement.className = 'nicotoolbox-settings-category-header';

            headerElement.innerHTML = `
                <div>
                    <div class="nicotoolbox-category-name">
                        Nicht zugeordnet
                    </div>

                    <div class="nicotoolbox-settings-subtitle">
                        ${uncategorized.length} AAO(s)
                    </div>
                </div>
            `;

            section.appendChild(headerElement);

            const content = document.createElement('div');

            content.className = 'nicotoolbox-settings-category-content';

            for (const aao of uncategorized) {
                content.appendChild(createSettingsAAORow(aao));
            }

            section.appendChild(content);

            panel.appendChild(section);
        }
    }

    function createSettingsAAORow(aao) {
        const row = document.createElement('div');

        row.className = 'nicotoolbox-settings-aao-row';

        const currentCategory = getCategoryForAAO(aao.key);

        row.innerHTML = `
            <span
                class="nicotoolbox-aao-drag-handle"
                draggable="true"
                title="AAO verschieben"
                aria-label="AAO verschieben"
            >
                ⋮⋮
            </span>

            <div class="nicotoolbox-settings-aao-info">
                <div class="nicotoolbox-settings-aao-name">
                    ${api.escapeHTML(aao.name)}
                </div>

                <div class="nicotoolbox-settings-aao-summary">
                    ${api.escapeHTML(aao.summary)}
                </div>
            </div>

            <select class="nicotoolbox-settings-aao-select">
                <option value="">
                    Nicht zugeordnet
                </option>

                ${categories.map(category => `
                    <option
                        value="${api.escapeHTML(category.id)}"
                        ${
                            currentCategory &&
                            currentCategory.id === category.id
                                ? 'selected'
                                : ''
                        }
                    >
                        ${api.escapeHTML(category.name)}
                    </option>
                `).join('')}
            </select>

            <button
                type="button"
                class="nicotoolbox-settings-edit"
                title="AAO bearbeiten"
            >
                ✎
            </button>

            <button
                type="button"
                class="nicotoolbox-settings-delete"
                title="AAO löschen"
            >
                ×
            </button>
        `;

        const dragHandle = row.querySelector('.nicotoolbox-aao-drag-handle');

        dragHandle.addEventListener('dragstart', event => {
            draggedAAOKey = aao.key;
            row.classList.add('nicotoolbox-aao-dragging');

            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', aao.key);
        });

        dragHandle.addEventListener('dragend', () => {
            draggedAAOKey = null;

            document.querySelectorAll(
                '.nicotoolbox-aao-dragging, .nicotoolbox-aao-drop-target'
            ).forEach(element => {
                element.classList.remove(
                    'nicotoolbox-aao-dragging',
                    'nicotoolbox-aao-drop-target'
                );
            });
        });

        row.addEventListener('dragover', event => {
            if (!draggedAAOKey || draggedAAOKey === aao.key) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';

            row.classList.add('nicotoolbox-aao-drop-target');
        });

        row.addEventListener('dragleave', event => {
            if (
                event.relatedTarget &&
                row.contains(event.relatedTarget)
            ) {
                return;
            }

            row.classList.remove('nicotoolbox-aao-drop-target');
        });

        row.addEventListener('drop', async event => {
            event.preventDefault();
            event.stopPropagation();

            row.classList.remove('nicotoolbox-aao-drop-target');

            const sourceKey =
                event.dataTransfer.getData('text/plain') ||
                draggedAAOKey;

            if (!sourceKey || sourceKey === aao.key) {
                return;
            }

            await moveAAOBefore(sourceKey, aao.key);
        });

        const select = row.querySelector('.nicotoolbox-settings-aao-select');

        select.addEventListener('change', async event => {
            event.preventDefault();
            event.stopPropagation();

            const value = select.value;

            if (value) {
                assignments[aao.key] = value;
            } else {
                delete assignments[aao.key];
            }

            await saveAssignments();

            renderSettingsPanel();
            renderDispatchPanel();
        });

        row.querySelector('.nicotoolbox-settings-edit')
            .addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                const original = originalAAORows.get(aao.key);

                if (!original) {
                    return;
                }

                const editButton = Array.from(
                    original.querySelectorAll('button')
                ).find(button => {
                    const svg = button.querySelector('svg');

                    return (
                        svg &&
                        (
                            svg.classList.contains('lucide-pencil') ||
                            svg.getAttribute('class')?.includes('pencil')
                        )
                    );
                });

                if (editButton) {
                    editButton.click();
                }
            });

        row.querySelector('.nicotoolbox-settings-delete')
            .addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                const original = originalAAORows.get(aao.key);

                if (!original) {
                    return;
                }

                const deleteButton = Array.from(
                    original.querySelectorAll('button')
                ).find(button => {
                    const svg = button.querySelector('svg');

                    const svgClass =
                        svg?.getAttribute('class') || '';

                    return (
                        svgClass.includes('trash') ||
                        /löschen|loeschen|delete/i.test(
                            button.textContent || ''
                        ) ||
                        /löschen|loeschen|delete/i.test(
                            button.getAttribute('title') || ''
                        )
                    );
                });

                if (deleteButton) {
                    deleteButton.click();
                }
            });

        return row;
    }

    /* =========================================================
       Search synchronization
       ========================================================= */

    function hookDispatchSearch(dialog) {
        const input = dialog?.querySelector(
            'input[placeholder="AAO suchen..."], input[placeholder="Suchen..."]'
        );

        if (!input) {
            return;
        }

        if (input.dataset.nicotoolboxSearchHooked === 'true') {
            return;
        }

        input.dataset.nicotoolboxSearchHooked = 'true';

        input.addEventListener('input', () => {
            dispatchSearchValue = input.value || '';

            renderDispatchPanel();
        });
    }

    /* =========================================================
       Applet lifecycle
       ========================================================= */

    async function init(context) {
        api = context;

        await loadData();

        injectStyles();
    }

    function onScan() {
        const catalogChanged = discoverAAOs();

        /* -----------------------------------------------------
           Settings
           ----------------------------------------------------- */

        const settingsSection = findSettingsAAOSection();

        if (settingsSection) {
            if (
                settingsSection !== lastSettingsSection ||
                !document.querySelector(
                    `#${AAO_SETTINGS_PANEL_ID}`
                ) ||
                catalogChanged
            ) {
                lastSettingsSection = settingsSection;

                renderSettingsPanel();
            }
        } else {
            lastSettingsSection = null;

            document.querySelector(
                `#${AAO_SETTINGS_PANEL_ID}`
            )?.remove();
        }

        /* -----------------------------------------------------
           Dispatch
           ----------------------------------------------------- */

        const dispatchDialog = findDispatchDialog();

        if (dispatchDialog) {
            hookDispatchSearch(dispatchDialog);

            if (!isDispatchAAOModeEnabled(dispatchDialog)) {
                removeDispatchPanel(
                    dispatchDialog,
                    findDispatchList(dispatchDialog)
                );

                lastDispatchContainer = dispatchDialog;

                return;
            }

            const list = findDispatchList(dispatchDialog);

            if (!list) {
                return;
            }

            if (
                dispatchDialog !== lastDispatchContainer ||
                !document.querySelector(
                    `#${AAO_DISPATCH_PANEL_ID}`
                ) ||
                catalogChanged
            ) {
                lastDispatchContainer = dispatchDialog;

                renderDispatchPanel();
            } else {
                updateAllDispatchItems();
            }
        } else {
            if (lastDispatchContainer) {
                selectedAAOs.clear();
            }

            lastDispatchContainer = null;
        }
    }

    function dispose() {
        document.querySelector(
            `#${AAO_SETTINGS_PANEL_ID}`
        )?.remove();

        const settingsContainer = findSettingsAAOContainer();

        if (settingsContainer) {
            settingsContainer.style.display = '';
        }

        const dispatchDialog = findDispatchDialog();

        removeDispatchPanel(
            dispatchDialog,
            dispatchDialog ? findDispatchList(dispatchDialog) : null
        );

        document.querySelector(
            `#${AAO_DISPATCH_PANEL_ID}`
        )?.remove();

        document.getElementById(STYLES_ID)?.remove();

        selectedAAOs.clear();
        aaoCatalog.clear();
        originalAAORows.clear();

        categories = [];
        assignments = {};

        lastDispatchContainer = null;
        lastSettingsSection = null;
        dispatchSearchValue = '';
        draggedCategoryID = null;
        draggedAAOKey = null;
        uncategorizedAAOOrder = [];

        api = null;
    }

    registerApplet({
        id: 'aaoCategories',
        name: 'AAO-Kategorien',
        description:
            'Sortiert AAOs in eigene Kategorien und ersetzt die AAO-Auswahl im Alarmierungsfenster durch eine kategorisierte Ansicht.',
        version: '1.0.3',
        init,
        onScan,
        dispose
    });
})();

/* NicoToolbox: mehrere Notizzettel und Einsatzfavoriten, vollständig lokal. */
(function () {
    'use strict';
    const STYLE = 'nicotoolbox-organizer-style';
    const BUTTON_CLASSES = 'w-10 h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 flex items-center justify-center cursor-pointer';
    function stop(event) { event.preventDefault(); event.stopPropagation(); }
    function styles() {
        if (document.getElementById(STYLE)) return;
        const style = document.createElement('style'); style.id = STYLE;
        style.textContent = `
            .nt-organizer{position:fixed;top:76px;right:64px;z-index:99998;width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 96px);display:flex;flex-direction:column;border:1px solid #3f4657;border-radius:14px;background:#181c26;color:#e8edf6;box-shadow:0 18px 55px #0007;font:13px/1.5 system-ui;overflow:hidden}
            .nt-organizer *{box-sizing:border-box}.nt-organizer header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#222838}.nt-organizer h2{margin:0;font-size:17px;font-weight:700}.nt-organizer h3{margin:0;font-size:14px;font-weight:650}
            .nt-organizer button{background:#30394c;border:1px solid #46516a;color:#f2f5ff;border-radius:7px;padding:6px 10px;cursor:pointer}.nt-organizer button:disabled{opacity:.5;cursor:default}.nt-organizer button:hover:not(:disabled){background:#3d4962}
            .nt-organizer input,.nt-organizer textarea,.nt-organizer select{width:100%;padding:9px;border:1px solid #414b60;border-radius:7px;background:#111620;color:#f2f5ff;font:inherit}.nt-organizer input:focus,.nt-organizer textarea:focus{outline:2px solid #818cf8}
            .nt-organizer textarea{min-height:150px;resize:vertical}.nt-organizer label{display:block;margin:8px 0 4px;color:#c6cfdf}.nt-org-body{padding:14px;overflow:auto}.nt-org-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}.nt-org-toolbar select{flex:1;min-width:0}
            .nt-org-status{padding:8px 14px;color:#a9b7cd;font-size:12px;min-height:32px;border-top:1px solid #30394c}.nt-org-hint{color:#a9b7cd;font-size:12px;margin:6px 0 12px}.nt-favorite-card{padding:12px;margin:10px 0;border:1px solid #414b60;border-radius:10px;background:#212838}.nt-favorite-card textarea{min-height:64px}.nt-favorite-card h3{overflow-wrap:anywhere}.nt-favorite-actions{display:flex;gap:8px;margin-top:10px}
            .nicotoolbox-mission-star{display:inline-flex!important;align-items:center;justify-content:center;width:30px;height:30px;margin-right:6px;border-radius:7px;border:1px solid #cbd5e1;background:#fff;color:#64748b;font-size:20px;cursor:pointer;vertical-align:middle;flex-shrink:0}.nicotoolbox-mission-star[aria-pressed="true"]{color:#a16207;background:#fef3c7;border-color:#eab308}
            .nt-fav-tool{position:relative;color:#facc15}.nt-fav-tool span{position:absolute;right:-5px;top:-5px;min-width:17px;border-radius:10px;background:#b45309;color:white;font-size:10px;padding:0 3px}
            #nicotoolbox-notepad-panel{top:15%;right:64px;width:min(340px,calc(100vw - 88px));max-height:70vh;border-color:var(--nt-note-accent,#3f3f46);border-radius:12px;background:var(--nt-note-bg,#18181b)}
            #nicotoolbox-notepad-panel header{padding:10px 12px;background:var(--nt-note-head,#27272a);border-bottom:1px solid #ffffff18}#nicotoolbox-notepad-panel h2{font-size:14px}
            #nicotoolbox-notepad-panel .nt-org-body{padding:10px 12px}#nicotoolbox-notepad-panel textarea{min-height:180px;border:0;background:transparent;padding:8px 0;resize:vertical}
            #nicotoolbox-notepad-panel input,#nicotoolbox-notepad-panel select{background:#0002;border-color:#ffffff20}#nicotoolbox-notepad-panel label{font-size:12px}
            .nt-note-colors{display:flex;gap:8px;align-items:center;margin:10px 0}.nt-organizer .nt-note-colors button{width:24px;height:24px;border-radius:50%;padding:0;border:2px solid transparent;background:var(--swatch)}.nt-organizer .nt-note-colors button[aria-pressed="true"]{outline:2px solid white;outline-offset:2px}
            .nt-mission-controls{display:flex;align-items:center;gap:8px;margin:8px 0;color:#475569;font:12px system-ui}.nt-mission-controls button,.nt-mission-controls select{border:1px solid #cbd5e1;border-radius:7px;padding:6px 9px;background:white;color:#475569;cursor:pointer}.nt-mission-controls .nicotoolbox-favorites-button{color:#a16207}.nt-not-favorite{display:none!important}
            .nt-favorite-menu-item{display:block;width:100%;padding:8px 12px;text-align:left;cursor:pointer;background:transparent;color:inherit;border:0}
            #nicotoolbox-notepad-panel{color-scheme:dark;--nt-control:#ffffff08;--nt-border:#ffffff20}
            #nicotoolbox-notepad-panel .nt-org-toolbar{gap:8px;margin-bottom:12px}
            #nicotoolbox-notepad-panel button:not([data-color]),#nicotoolbox-notepad-panel input,#nicotoolbox-notepad-panel select{border:1px solid var(--nt-border);border-radius:8px;background-color:var(--nt-control);color:#f4f4f5;min-height:34px;box-shadow:none}
            #nicotoolbox-notepad-panel button:not([data-color]):hover:not(:disabled){background-color:#ffffff12;border-color:#ffffff38}
            #nicotoolbox-notepad-panel button:disabled{opacity:.4}
            #nicotoolbox-notepad-panel header button{width:30px;min-height:30px;padding:0;background:transparent}
            #nicotoolbox-notepad-panel select{appearance:none;padding:8px 32px 8px 11px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
            #nicotoolbox-notepad-panel select option{background:#27272a;color:#f4f4f5}
            #nicotoolbox-notepad-panel input{padding:9px 11px}
            #nicotoolbox-notepad-panel textarea{line-height:1.65;color:#f4f4f5}
            #nicotoolbox-notepad-panel label{color:#a1a1aa}
            #nicotoolbox-notepad-panel .nt-org-status{color:#a1a1aa;border-top:1px solid var(--nt-border);background:#0001;font-size:11px}
            #nicotoolbox-notepad-panel .nt-note-colors{gap:10px;margin:14px 2px}
            #nicotoolbox-notepad-panel .nt-note-colors button{min-height:0;box-shadow:inset 0 0 0 1px #ffffff18;transition:transform .12s}
            #nicotoolbox-notepad-panel .nt-note-colors button:hover{transform:scale(1.1)}
            #nicotoolbox-notepad-panel :is(button,select,input,textarea):focus-visible{outline:2px solid var(--nt-note-accent,#a1a1aa);outline-offset:2px}
            .nicotoolbox-notepad-button{color:#e4e4e7;width:40px;height:40px}
            .nicotoolbox-notepad-button svg{width:18px;height:18px;display:block;pointer-events:none}
            #nicotoolbox-notepad-panel header{cursor:grab;touch-action:none;user-select:none}
            #nicotoolbox-notepad-panel header:active{cursor:grabbing}
            @media(max-width:600px){.nt-organizer{right:12px;top:64px;max-height:calc(100dvh - 80px)}}
        `;
        document.head.appendChild(style);
    }
    function mount(api, className, title, icon, click) {
        const slot = api.getAppletSlot();
        if (!slot || slot.querySelector('.' + className)) return;
        const button = document.createElement('button');
        button.type = 'button'; button.className = className + ' ' + BUTTON_CLASSES;
        button.title = title; button.setAttribute('aria-label', title);
        button.innerHTML = className === 'nicotoolbox-notepad-button'
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>'
            : `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
        button.addEventListener('click', event => { stop(event); click(); });
        api.mountAppletButton(button);
    }
    function panel(id, title, close) {
        const element = document.createElement('section');
        element.id = id; element.className = 'nt-organizer'; element.setAttribute('role', 'dialog');
        element.setAttribute('aria-label', title);
        element.innerHTML = `<header><h2>${title}</h2><button type="button" aria-label="Schließen">×</button></header><div class="nt-org-body"></div><div class="nt-org-status" role="status"></div>`;
        element.querySelector('header button').onclick = close;
        element.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
        element.addEventListener('click', event => event.stopPropagation());
        document.body.appendChild(element);
        return element;
    }

    // Notizen: alter einzelner Notiztext wird einmalig übernommen.
    (function () {
        const KEY = 'notepadSheetsV1', PANEL = 'nicotoolbox-notepad-panel', BUTTON = 'nicotoolbox-notepad-button';
        const COLORS = { dark: ['Dunkel', '#18181b', '#27272a', '#71717a'], yellow: ['Gelb', '#302b19', '#483d1d', '#facc15'], green: ['Grün', '#192f27', '#224536', '#4ade80'], blue: ['Blau', '#19283b', '#223d59', '#60a5fa'], pink: ['Rosa', '#321f30', '#4c2b44', '#f472b6'], purple: ['Lila', '#292039', '#3c2d54', '#a78bfa'] };
        let api, notes = [], selected = '', deleted = null, ready = false, revision = 0;
        let writes = Promise.resolve();
        let dragCleanup = null;
        function current() { return notes.find(note => note.id === selected); }
        function status(text) { const el = document.querySelector('#' + PANEL + ' .nt-org-status'); if (el) el.textContent = text; }
        function save() {
            const data = notes.map(note => ({ ...note })); const version = ++revision;
            status('Speichert …');
            writes = writes.catch(() => {}).then(() => api.dbSet(KEY, data)).then(() => {
                if (version === revision) status('Lokal gespeichert');
            }).catch(error => { status('Speichern fehlgeschlagen. Fenster geöffnet lassen und erneut bearbeiten.'); console.error('[NicoToolbox] Notizen:', error); });
            return writes;
        }
        function options() {
            const select = document.querySelector('#' + PANEL + ' select'); if (!select) return;
            select.innerHTML = notes.map(note => `<option value="${api.escapeHTML(note.id)}">${api.escapeHTML(note.title || 'Ohne Titel')}</option>`).join('');
            select.value = selected;
        }
        function editor() {
            const root = document.getElementById(PANEL); if (!root) return;
            const note = current(); options();
            root.querySelector('[data-title]').value = note?.title || '';
            root.querySelector('textarea').value = note?.text || '';
            root.querySelector('[data-undo]').disabled = !deleted;
            color();
            positionNote();
        }
        function positionNote() {
            const root = document.getElementById(PANEL); if (!root) return;
            const position = current()?.position;
            if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
                root.style.left = ''; root.style.top = ''; root.style.right = '';
                return;
            }
            const bounds = root.getBoundingClientRect();
            root.style.left = Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8)) + 'px';
            root.style.top = Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8)) + 'px';
            root.style.right = 'auto';
        }
        function makeMovable(root) {
            const header = root.querySelector('header');
            header.title = 'Notizzettel verschieben';
            let drag = null;
            header.addEventListener('pointerdown', event => {
                if (event.button !== 0 || event.target.closest('button')) return;
                event.preventDefault(); event.stopPropagation();
                const bounds = root.getBoundingClientRect();
                drag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, pointer: event.pointerId };
                header.setPointerCapture(event.pointerId);
            });
            header.addEventListener('pointermove', event => {
                if (!drag || event.pointerId !== drag.pointer) return;
                current().position = { x: event.clientX - drag.x, y: event.clientY - drag.y };
                positionNote();
            });
            const finish = event => {
                if (!drag) return;
                drag = null;
                if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
                const bounds = root.getBoundingClientRect();
                current().position = { x: bounds.left, y: bounds.top }; save();
            };
            header.addEventListener('pointerup', finish);
            header.addEventListener('pointercancel', finish);
            header.addEventListener('lostpointercapture', finish);
            window.addEventListener('resize', positionNote);
            dragCleanup = () => window.removeEventListener('resize', positionNote);
        }
        function color() {
            const root = document.getElementById(PANEL); if (!root) return;
            const name = Object.hasOwn(COLORS, current()?.color) ? current().color : 'dark';
            const value = COLORS[name];
            root.style.setProperty('--nt-note-bg', value[1]); root.style.setProperty('--nt-note-head', value[2]); root.style.setProperty('--nt-note-accent', value[3]);
            root.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === name)));
        }
        function close() { dragCleanup?.(); dragCleanup = null; document.getElementById(PANEL)?.remove(); document.querySelector('.' + BUTTON)?.focus(); }
        function open() {
            if (document.getElementById(PANEL)) { close(); return; }
            const root = panel(PANEL, 'Notizzettel', close);
            makeMovable(root);
            root.querySelector('.nt-org-body').innerHTML = `<div class="nt-org-toolbar"><select aria-label="Notizzettel auswählen"></select><button type="button" data-new>+ Neu</button></div><label for="nt-note-title">Titel</label><input id="nt-note-title" data-title maxlength="120"><label for="nt-note-text">Notiz</label><textarea id="nt-note-text" placeholder="Deine Notiz …"></textarea><div class="nt-favorite-actions"><button type="button" data-delete>Löschen</button><button type="button" data-undo disabled>Rückgängig</button></div>`;
            const palette = document.createElement('div'); palette.className = 'nt-note-colors'; palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', 'Zettelfarbe');
            palette.innerHTML = Object.entries(COLORS).map(([name, value]) => `<button type="button" data-color="${name}" title="${value[0]}" aria-label="${value[0]}" aria-pressed="false" style="--swatch:${value[3]}"></button>`).join('');
            root.querySelector('[data-title]').after(palette);
            palette.onclick = event => { const button = event.target.closest('[data-color]'); if (!button) return; current().color = button.dataset.color; color(); save(); };
            root.querySelector('select').onchange = event => { selected = event.target.value; editor(); };
            root.querySelector('[data-new]').onclick = () => {
                const note = { id: api.createID('note'), title: 'Neuer Notizzettel', text: '' };
                notes.push(note); selected = note.id; editor(); save(); root.querySelector('[data-title]').select();
            };
            root.querySelector('[data-title]').oninput = event => { current().title = event.target.value; options(); save(); };
            root.querySelector('textarea').oninput = event => { current().text = event.target.value; save(); };
            root.querySelector('[data-delete]').onclick = () => {
                deleted = { ...current() }; notes = notes.filter(note => note.id !== selected);
                if (!notes.length) notes.push({ id: api.createID('note'), title: 'Notizzettel', text: '' });
                selected = notes[0].id; editor(); save();
            };
            root.querySelector('[data-undo]').onclick = () => { if (!deleted) return; notes.push(deleted); selected = deleted.id; deleted = null; editor(); save(); };
            editor(); status('Änderungen werden automatisch lokal gespeichert.'); root.querySelector('textarea').focus();
        }
        async function init(context) {
            api = context; ready = false;
            const stored = await api.dbGet(KEY);
            if (stored !== undefined && (!Array.isArray(stored) || stored.some(note => !note || typeof note.id !== 'string' || typeof note.text !== 'string' || typeof note.title !== 'string'))) throw new Error('Ungültige gespeicherte Notizzettel; Daten wurden nicht überschrieben.');
            notes = stored || [];
            if (!notes.length) {
                const legacy = await api.dbGet('notepad');
                notes = [{ id: api.createID('note'), title: 'Notizzettel', text: typeof legacy === 'string' ? legacy : '' }];
                await api.dbSet(KEY, notes);
            }
            selected = notes[0].id; ready = true; styles();
        }
        function onScan() { if (ready) mount(api, BUTTON, 'Notizzettel öffnen', 'fa-note-sticky', open); }
        async function dispose() { ready = false; close(); document.querySelectorAll('.' + BUTTON).forEach(el => el.remove()); await writes; }
        registerApplet({ id: 'notepad', name: 'Notizzettel', description: 'Mehrere Notizen mit eigenen Titeln und automatischer lokaler Speicherung.', version: '2.0.0', init, onScan, dispose });
    })();

    (function () {
        const PANEL = 'nicotoolbox-favorites-panel', BUTTON = 'nicotoolbox-favorites-button', STAR = 'nicotoolbox-mission-star';
        let api, favorites = [], game = '', ready = false, active = false, generation = 0, deleted = null;
        let writes = Promise.resolve(), cards = [];
        let favoritesOnly = false;
        const nativeSelects = new Map();
        const titleOf = row => row.title || 'Einsatz';
        function gameID() { const match = location.pathname.match(/\/game\/([^/]+)/); return new URLSearchParams(location.search).get('gameSessionId') || (match ? decodeURIComponent(match[1]) : ''); }
        function key(id) { return 'missionFavoritesV1:' + id; }
        function status(text) { const el = document.querySelector('#' + PANEL + ' .nt-org-status'); if (el) el.textContent = text; }
        function save() {
            const id = game, data = favorites.map(row => ({ ...row }));
            status('Speichert …');
            writes = writes.catch(() => {}).then(() => api.dbSet(key(id), data)).then(() => { if (game === id) status('Lokal gespeichert'); }).catch(error => { status('Favoriten konnten nicht gespeichert werden. Bitte erneut versuchen.'); console.error('[NicoToolbox] Favoriten:', error); });
            updateCount(); return writes;
        }
        async function load(id) {
            const token = ++generation; ready = false; favorites = []; deleted = null; game = id; favoritesOnly = false;
            document.querySelectorAll('.nt-not-favorite').forEach(row => row.classList.remove('nt-not-favorite'));
            document.querySelectorAll('.' + STAR).forEach(el => el.remove()); render(); updateCount();
            if (!id) { status('Öffne eine Spielrunde, um Einsätze zu favorisieren.'); return; }
            try {
                await writes;
                const stored = await api.dbGet(key(id));
                if (!active || token !== generation) return;
                if (stored !== undefined && (!Array.isArray(stored) || stored.some(row => !row || typeof row.id !== 'string' || typeof row.title !== 'string'))) throw new Error('Ungültige gespeicherte Favoriten');
                favorites = stored || []; ready = true; render(); onScan();
            } catch (error) { if (token === generation) status('Favoriten konnten nicht geladen werden.'); console.error('[NicoToolbox] Favoriten:', error); }
        }
        // Nur sichtbare Einsatzkarten mit dem Auge-Symbol berücksichtigen.
        // Bevorzugt eindeutige DOM-IDs; ohne ID niemals gleichnamige Karten zusammenfassen.
        function discover() {
            const result = [], seen = new Set();
            for (const icon of document.querySelectorAll('i.fa-eye, svg[data-icon="eye"]')) {
                if (icon.closest('.nt-organizer')) continue;
                const action = icon.closest('button, a, [role="button"]'); if (!action) continue;
                let row = action.parentElement;
                for (let depth = 0; row && depth < 6; depth++, row = row.parentElement) {
                    if (row.querySelectorAll('i.fa-eye, svg[data-icon="eye"]').length !== 1) break;
                    const heading = row.querySelector('h3, h4, [data-mission-name], .font-semibold, .font-medium');
                    const title = heading?.textContent.trim();
                    if (!title || title.length > 180 || heading.closest('button')) continue;
                    let context = row.parentElement, isMission = false;
                    for (let index = 0; context && index < 5; index++, context = context.parentElement) {
                        if ([...context.querySelectorAll('h2,h3')].some(el => /^Einsätze(?:\s|\(|$)/i.test(el.textContent.trim()))) { isMission = true; break; }
                        if (context === document.body) break;
                    }
                    if (!isMission || seen.has(row) || (!row.getClientRects().length && !row.classList.contains('nt-not-favorite'))) break;
                    // Die komplette Karte ausblenden, nicht nur ihre innere Textzeile.
                    let outer = row;
                    for (let index = 0; outer && index < 4; index++, outer = outer.parentElement) {
                        if (outer.querySelectorAll('i.fa-eye, svg[data-icon="eye"]').length !== 1 || outer.querySelector('h2')) break;
                        if (outer.hasAttribute('data-mission-id') || (outer.classList.contains('border') && [...outer.classList].some(name => name.startsWith('rounded')))) { row = outer; break; }
                    }
                    const id = row.getAttribute('data-mission-id') || row.querySelector('[data-mission-id]')?.getAttribute('data-mission-id');
                    const href = action.getAttribute('href');
                    let url = '';
                    if (href) { const parsed = new URL(href, location.href); if (parsed.origin === location.origin && /\/missions?\//.test(parsed.pathname)) url = parsed.href; }
                    seen.add(row); result.push({ row, action, title, key: id ? 'id:' + id : url ? 'url:' + url : 'title:' + title, url }); break;
                }
            }
            return result;
        }
        function unique(card) { return cards.filter(other => other.key === card.key).length === 1; }
        function matching(card) { return favorites.find(row => row.match === card.key); }
        function toggle(card) {
            if (!ready || gameID() !== game || !unique(card)) return;
            const existing = matching(card);
            if (existing) { deleted = { ...existing }; favorites = favorites.filter(row => row.id !== existing.id); }
            else favorites.push({ id: api.createID('favorite'), title: card.title, match: card.key, url: card.url, note: '', createdAt: Date.now() });
            save(); render(); onScan();
        }
        function updateCount() {
            const button = document.querySelector('.' + BUTTON); if (!button) return;
            let count = button.querySelector('span');
            if (!count) { count = document.createElement('span'); button.appendChild(count); }
            const value = String(favorites.length); if (count.textContent !== value) count.textContent = value;
            const title = 'Favorisierte Einsätze (' + value + ')'; if (button.title !== title) { button.title = title; button.setAttribute('aria-label', title); }
        }
        function close() { document.getElementById(PANEL)?.remove(); document.querySelector('.' + BUTTON)?.focus(); }
        function render() {
            const root = document.getElementById(PANEL); if (!root) return;
            const query = root.querySelector('[data-search]').value.toLocaleLowerCase('de');
            root.querySelector('[data-add]').disabled = !ready;
            root.querySelector('[data-undo]').disabled = !ready || !deleted;
            root.querySelector('[data-list]').innerHTML = favorites.filter(row => (row.title + ' ' + (row.note || '')).toLocaleLowerCase('de').includes(query)).map(row => `
                <article class="nt-favorite-card" data-id="${api.escapeHTML(row.id)}"><h3>★ ${api.escapeHTML(titleOf(row))}</h3>
                <label>Fehlende Einheiten / Merker<textarea aria-label="Merker für ${api.escapeHTML(titleOf(row))}" placeholder="z. B. 2 RTW und 1 NEF fehlen">${api.escapeHTML(row.note || '')}</textarea></label>
                <div class="nt-favorite-actions"><button type="button" data-locate>In Einsatzliste finden</button><button type="button" data-remove>Entfernen</button></div></article>`).join('') || '<p class="nt-org-hint">Noch keine passenden Favoriten. Markiere einen Einsatz mit ★ oder lege einen Merker an.</p>';
            for (const element of root.querySelectorAll('[data-id]')) {
                const favorite = favorites.find(row => row.id === element.dataset.id);
                element.querySelector('textarea').oninput = event => { favorite.note = event.target.value; save(); };
                element.querySelector('[data-remove]').onclick = () => { deleted = { ...favorite }; favorites = favorites.filter(row => row.id !== favorite.id); save(); render(); onScan(); };
                element.querySelector('[data-locate]').onclick = () => {
                    cards = discover(); const found = cards.filter(card => favorite.match ? card.key === favorite.match : card.title === favorite.title);
                    if (found.length !== 1) { status(found.length ? 'Mehrere gleichnamige Einsätze. Bitte den richtigen Einsatz in der Spiel-Liste auswählen.' : 'Öffne im Dispatcher den Reiter Einsätze. Der Einsatz ist dort eventuell nicht mehr vorhanden oder wird durch einen Filter ausgeblendet.'); return; }
                    found[0].row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    found[0].row.animate([{ outline: '3px solid #facc15' }, { outline: '3px solid transparent' }], { duration: 1600 });
                    status('Einsatz in der Liste hervorgehoben.');
                };
            }
        }
        function open() {
            if (document.getElementById(PANEL)) { close(); return; }
            const root = panel(PANEL, 'Favorisierte Einsätze', close);
            root.querySelector('.nt-org-body').innerHTML = `<p class="nt-org-hint">Merke dir Einsätze und trage fehlende Einheiten ein. Favoriten bleiben bis zum manuellen Entfernen gespeichert – getrennt nach Spielrunde.</p><input type="search" data-search aria-label="Favoriten durchsuchen" placeholder="Favoriten durchsuchen …"><div class="nt-favorite-actions"><button type="button" data-add>+ Einsatz merken</button><button type="button" data-undo>Rückgängig</button></div><div data-list></div>`;
            root.querySelector('[data-search]').oninput = render;
            root.querySelector('[data-add]').onclick = () => {
                const title = window.prompt('Einsatzname für den Merker:'); if (!title?.trim()) return;
                favorites.push({ id: api.createID('favorite'), title: title.trim(), note: '', createdAt: Date.now() }); save(); render();
            };
            root.querySelector('[data-undo]').onclick = () => { if (!deleted) return; favorites.push(deleted); deleted = null; save(); render(); onScan(); };
            render(); status(ready ? 'Fehlende Einheiten werden von dir eingetragen.' : 'Spielrunde wird geladen oder ist noch nicht geöffnet.'); root.querySelector('[data-search]').focus();
        }
        async function init(context) { api = context; active = true; styles(); await load(gameID()); }
        function setFilter(enabled) {
            favoritesOnly = enabled;
            if (!enabled) for (const [select, binding] of nativeSelects) {
                if (select.value === 'nicotoolbox-favorites') select.value = binding.previous;
            }
            onScan();
            document.querySelectorAll('.nt-mission-controls').forEach(controls => {
                let hint = controls.querySelector('[data-filter-hint]');
                if (!hint) { hint = document.createElement('span'); hint.dataset.filterHint = 'true'; hint.setAttribute('role', 'status'); controls.appendChild(hint); }
                hint.textContent = favoritesOnly ? 'Nur favorisierte Einsätze' : '';
            });
        }
        function hookMissionControls() {
            const headings = [...document.querySelectorAll('h2,h3')].filter(el => /^Einsätze(?:\s|\(|$)/i.test(el.textContent.trim()) && !el.closest('.nt-organizer'));
            for (const heading of headings) {
                let controls = heading.nextElementSibling;
                if (!controls?.classList.contains('nt-mission-controls')) {
                    controls = document.createElement('div'); controls.className = 'nt-mission-controls';
                    controls.innerHTML = `<button type="button" class="${BUTTON}" aria-label="Favorisierte Einsätze öffnen" title="Favorisierte Einsätze öffnen">★ <span>0</span></button>`;
                    controls.querySelector('button').onclick = event => { stop(event); open(); };
                    heading.after(controls);
                }
                const region = heading.parentElement;
                for (const select of region.querySelectorAll('select:not(.nt-mission-controls select)')) {
                    if (!/Nach Eingang/i.test(select.textContent) || nativeSelects.has(select)) continue;
                    const binding = { previous: select.value, handler: null };
                    for (const [value, label] of [['nicotoolbox-all', 'Alle Einträge'], ['nicotoolbox-favorites', 'Favorisierte Einträge']]) {
                        const option = document.createElement('option'); option.value = value; option.textContent = label; option.dataset.ntFavoriteOption = 'true'; select.appendChild(option);
                    }
                    binding.handler = event => {
                        if (select.value.startsWith('nicotoolbox-')) { event.stopImmediatePropagation(); setFilter(select.value === 'nicotoolbox-favorites'); }
                        else { binding.previous = select.value; setFilter(false); }
                    };
                    select.addEventListener('change', binding.handler, true); nativeSelects.set(select, binding);
                }
            }
            // Auch portalisierte Sortiermenüs unterstützen, sofern deren Inhalt passt.
            for (const menu of document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content]')) {
                const trigger = [...document.querySelectorAll('button[aria-expanded="true"], [role="combobox"][aria-expanded="true"]')].find(button => /Nach Eingang/i.test(button.textContent));
                if (!headings.length || (!/Nach Eingang/i.test(menu.textContent) && !trigger)) continue;
                if (menu.querySelector('.nt-favorite-menu-item')) {
                    for (const button of menu.querySelectorAll('.nt-favorite-menu-item')) {
                        const attribute = menu.getAttribute('role') === 'listbox' ? 'aria-selected' : 'aria-checked';
                        const value = String((button.dataset.favorites === 'true') === favoritesOnly);
                        if (button.getAttribute(attribute) !== value) button.setAttribute(attribute, value);
                    }
                    continue;
                }
                for (const [label, enabled] of [['Alle Einträge', false], ['Favorisierte Einträge', true]]) {
                    const button = document.createElement('button'); button.type = 'button'; button.className = 'nt-favorite-menu-item'; button.textContent = label;
                    button.dataset.favorites = String(enabled);
                    button.setAttribute('role', menu.getAttribute('role') === 'listbox' ? 'option' : 'menuitemradio');
                    button.setAttribute(menu.getAttribute('role') === 'listbox' ? 'aria-selected' : 'aria-checked', String(enabled === favoritesOnly));
                    button.onclick = event => { stop(event); setFilter(enabled); if (trigger?.isConnected && trigger.getAttribute('aria-expanded') === 'true') trigger.click(); }; menu.appendChild(button);
                }
            }
        }
        function onScan() {
            if (!active) return;
            if (gameID() !== game) { load(gameID()); return; }
            hookMissionControls();
            updateCount(); if (!ready) return;
            cards = discover();
            const anchors = new Set(cards.map(card => card.action));
            for (const star of document.querySelectorAll('.' + STAR)) if (!anchors.has(star.nextElementSibling)) star.remove();
            for (const card of cards) {
                let star = card.action.previousElementSibling;
                if (!star?.classList.contains(STAR)) { star = document.createElement('button'); star.type = 'button'; star.className = STAR; card.action.before(star); }
                const pressed = !!matching(card), ambiguous = !unique(card);
                const label = ambiguous ? 'Einsatz nicht eindeutig. Über die Favoritenliste einen eigenen Merker anlegen.' : pressed ? 'Einsatz aus Favoriten entfernen' : 'Einsatz favorisieren';
                if (star.disabled !== ambiguous) star.disabled = ambiguous;
                if (star.title !== label) { star.title = label; star.setAttribute('aria-label', label); }
                if (star.getAttribute('aria-pressed') !== String(pressed)) star.setAttribute('aria-pressed', String(pressed));
                const text = pressed ? '★' : '☆'; if (star.textContent !== text) star.textContent = text;
                star.onclick = event => { stop(event); toggle(card); };
                const hide = favoritesOnly && !pressed;
                if (card.row.classList.contains('nt-not-favorite') !== hide) card.row.classList.toggle('nt-not-favorite', hide);
            }
        }
        async function dispose() {
            active = false; ready = false; generation++; close();
            document.querySelectorAll('.nt-not-favorite').forEach(el => el.classList.remove('nt-not-favorite'));
            document.querySelectorAll('.nt-mission-controls, .' + STAR + ', .nt-favorite-menu-item, [data-nt-favorite-option]').forEach(el => el.remove());
            for (const [select, binding] of nativeSelects) { select.removeEventListener('change', binding.handler, true); if (!select.value) select.value = binding.previous; }
            nativeSelects.clear(); await writes;
        }
        registerApplet({ id: 'missionFavorites', name: 'Einsatzfavoriten', description: 'Einsätze mit Stern markieren und fehlende Einheiten als Merker festhalten.', version: '1.0.0', init, onScan, dispose });
    })();
})();


/* NicoToolbox – FMS-Sprechwunsch: optische Anzeige. */
(function () {
    'use strict';
    const BADGE_SELECTOR =
        'div.absolute[class~="-top-2"][class~="-right-2"]' +
        '[class~="bg-red-500"][class~="text-white"]' +
        '[class~="w-6"][class~="h-6"][class~="rounded-full"]' +
        '[class~="border-gray-900"][class~="z-10"]';


    const STATUS_ANCHOR_ICONS = ['fa-money-bill', 'fa-arrow-trend-down', 'fa-star'];
    const STATUS_MIN_ANCHORS = 2;
    const STATUS_CLASS = 'nicotoolbox-fms-alert-status';
    const STYLES_ID = 'nicotoolbox-applet-fms-alert-styles';
    let statusBar = null;
    let lastStatusHost = null;
    let isActive = false;
    let watchTimer = null;
    function isElementVisible(element) {
        if (!element || !element.isConnected) {
            return false;
        }

        const rect = element.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const style = window.getComputedStyle(element);

        if (style.display === 'none') {
            return false;
        }

        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
            return false;
        }

        if (Number.parseFloat(style.opacity) === 0) {
            return false;
        }

        return true;
    }

    function isBadgeActive() {
        return isElementVisible(
            document.querySelector(BADGE_SELECTOR)
        );
    }


    function countStatusAnchors(row) {
        return STATUS_ANCHOR_ICONS.filter(iconClass => {
            return row.querySelector(`i.${iconClass}`);
        }).length;
    }

    function findStatusRow(icon) {
        let node = icon.parentElement;

        while (node && node !== document.body) {
            if (node.classList.contains('flex-row')) {
                /* Nur die eigentliche Statuszeile, nicht irgendein
                   darüberliegender Flex-Container. */
                return countStatusAnchors(node) >= STATUS_MIN_ANCHORS
                    ? node
                    : null;
            }

            node = node.parentElement;
        }

        return null;
    }

    function findStatusHost() {
        for (const iconClass of STATUS_ANCHOR_ICONS) {
            const icons = document.querySelectorAll(`i.${iconClass}`);

            for (const icon of icons) {
                const row = findStatusRow(icon);

                const host = row ? row.parentElement : null;

                if (host && host !== document.body) {
                    return host;
                }
            }
        }

        return null;
    }

    function createStatusBar() {
        const bar = document.createElement('div');

        bar.className =
            `${STATUS_CLASS} flex flex-row items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-md`;

        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');

        bar.innerHTML = `
            <i class="fa-solid fa-bell text-red-400 text-xs sm:text-base"></i>

            <div class="flex flex-col items-center leading-none sm:leading-tight">
                <span class="text-[9px] sm:text-[10px] text-red-300">
                    FMS 5
                </span>

                <span class="font-semibold text-white">
                    Sprechwunsch!
                </span>
            </div>
        `;

        return bar;
    }

    function removeStatusBar() {
        /* Nicht nur die zuletzt eingefügte Instanz entfernen: baut das
           Spiel den Kopfbereich per Clone neu auf, existiert unser
           Balken sonst doppelt. */

        document
            .querySelectorAll(`.${STATUS_CLASS}`)
            .forEach(bar => bar.remove());

        statusBar = null;
        lastStatusHost = null;
    }

    function hookStatusBar() {
        if (!isActive) {
            removeStatusBar();

            return;
        }

        const host = findStatusHost();

        if (!host) {
            return;
        }

        /* Das Spiel baut den Kopfbereich gelegentlich neu auf. */

        if (
            statusBar &&
            host === lastStatusHost &&
            host.nextElementSibling === statusBar
        ) {
            return;
        }

        removeStatusBar();

        lastStatusHost = host;

        statusBar = createStatusBar();

        host.after(statusBar);
    }


    function onScan() {
        isActive = isBadgeActive();
        hookStatusBar();
    }
    function init() {
        if (!document.getElementById(STYLES_ID)) {
            const style = document.createElement('style');
            style.id = STYLES_ID;
            style.textContent = `
                .${STATUS_CLASS} {
                    margin-top: 6px;
                    border: 1px solid #ef4444;
                    background: rgba(127, 29, 29, 0.9);
                    color: white;
                }
            `;
            document.head.appendChild(style);
        }
        onScan();
        if (watchTimer === null) watchTimer = setInterval(onScan, 1000);
    }
    function dispose() {
        if (watchTimer !== null) clearInterval(watchTimer);
        watchTimer = null;
        removeStatusBar();
        document.getElementById(STYLES_ID)?.remove();
        isActive = false;
    }
    registerApplet({
        id: 'fmsAlert',
        name: 'FMS-5-Anzeige',
        description: 'Zeigt bei einem Sprechwunsch einen roten Hinweis in der Statusleiste.',
        version: '1.1.0-local.1',
        init, onScan, dispose
    });
})();

/* =========================================================
   NicoToolbox – Applet: Map Darkmode
   Direkt eingebettet und lokal im Kernskript registriert.
   ========================================================= */

(function () {
    'use strict';

    /* Die Karte ist ein MapLibre-Canvas. Ein CSS-Filter auf
       diesem Canvas dunkelt Kacheln, Wasser und Linien ab.
       Wichtig ist das !important, damit ein Filter des Spiels
       nicht überlagert wird. */

    const CANVAS_SELECTOR = 'canvas.maplibregl-canvas';
    const CANVAS_ACTIVE_CLASS = 'nicotoolbox-map-darkmode-canvas';

    const DARK_FILTER =
        'brightness(0.55) contrast(1.15) saturate(0.65)';

    const BUTTON_CLASS = 'nicotoolbox-map-darkmode-button';
    const BUTTON_ACTIVE_CLASS =
        'nicotoolbox-map-darkmode-button-active';

    const STYLES_ID = 'nicotoolbox-applet-map-darkmode-styles';
    const STORE_KEY = 'mapDarkmode';

    let api = null;

    let darkMode = false;
    let lastButtonSlot = null;

    /* =========================================================
       Styles
       ========================================================= */

    function injectStyles() {
        if (document.getElementById(STYLES_ID)) {
            return;
        }

        const style = document.createElement('style');

        style.id = STYLES_ID;

        style.textContent = `
            .${CANVAS_ACTIVE_CLASS} {
                filter: ${DARK_FILTER} !important;
            }

            .${BUTTON_CLASS}:hover {
                border-color: #a1a1aa;
            }

            .${BUTTON_ACTIVE_CLASS} {
                border-color: rgba(129, 140, 248, 0.85);
            }

            .${BUTTON_ACTIVE_CLASS}:hover {
                border-color: #818cf8;
            }

            .${BUTTON_ACTIVE_CLASS} i {
                color: #c7d2fe;
            }
        `;

        document.head.appendChild(style);
    }

    /* =========================================================
       Karte
       ========================================================= */

    /* Das Spiel legt die Karte neu an, zum Beispiel beim Wechsel
       in einen neuen Einsatz. Deshalb werden alle vorhandenen
       Canvas jedes Mal neu geholt und nicht nur einer gecacht. */

    function getMapCanvases() {
        return document.querySelectorAll(CANVAS_SELECTOR);
    }

    function setCanvasDarkMode(canvas, enabled) {
        if (
            canvas.classList.contains(CANVAS_ACTIVE_CLASS) ===
            enabled
        ) {
            return;
        }

        canvas.classList.toggle(
            CANVAS_ACTIVE_CLASS,
            enabled
        );
    }

    function applyMap() {
        for (const canvas of getMapCanvases()) {
            setCanvasDarkMode(canvas, darkMode);
        }
    }

    function clearMap() {
        for (const canvas of getMapCanvases()) {
            setCanvasDarkMode(canvas, false);
        }
    }

    /* =========================================================
       Umschalten
       ========================================================= */

    function setDarkMode(enabled) {
        if (darkMode === !!enabled) {
            return;
        }

        darkMode = !!enabled;

        applyMap();
        updateButton();

        saveDarkMode();
    }

    function toggleDarkMode() {
        setDarkMode(!darkMode);
    }

    /* =========================================================
       Persistence
       ========================================================= */

    async function loadDarkMode() {
        try {
            const stored = await api.dbGet(STORE_KEY);

            darkMode = stored === true;
        } catch (error) {
            console.warn(
                '[NicoToolbox] Map Darkmode state failed:',
                error
            );

            darkMode = false;
        }
    }

    async function saveDarkMode() {
        try {
            await api.dbSet(STORE_KEY, darkMode);
        } catch (error) {
            console.warn(
                '[NicoToolbox] Map Darkmode save failed:',
                error
            );
        }
    }

    /* =========================================================
       UI
       ========================================================= */

    function findButtonSlot() {
        if (!api) {
            return null;
        }

        /* Das Icon hängt im aufklappbaren Slot der Toolbox. */

        return api.getAppletSlot();
    }

    function createButton() {
        const button = document.createElement('button');

        button.type = 'button';

        button.className =
            `${BUTTON_CLASS} w-10 h-10 sm:w-10 sm:h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 hover:border-gray-700 transition-all duration-300 flex items-center justify-center cursor-pointer`;

        button.setAttribute('aria-pressed', 'false');

        button.innerHTML =
            '<i class="fa-solid fa-moon text-sm sm:text-sm text-white/80"></i>';

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            toggleDarkMode();
        });

        return button;
    }

    function hookButton() {
        const slot = findButtonSlot();

        if (!slot) {
            lastButtonSlot = null;

            return;
        }

        const existing = slot.querySelector(`.${BUTTON_CLASS}`);

        if (slot === lastButtonSlot && existing) {
            updateButton();

            return;
        }

        lastButtonSlot = slot;

        if (existing) {
            existing.remove();
        }

        api.mountAppletButton(createButton());

        updateButton();
    }

    function updateButton() {
        const button = lastButtonSlot?.querySelector(
            `.${BUTTON_CLASS}`
        );

        if (!button) {
            return;
        }

        button.setAttribute(
            'aria-pressed',
            darkMode ? 'true' : 'false'
        );

        button.title = darkMode
            ? 'Karte aufhellen'
            : 'Karte abdunkeln';

        button.classList.toggle(
            BUTTON_ACTIVE_CLASS,
            darkMode
        );

        const icon = button.querySelector('i');

        if (!icon) {
            return;
        }

        icon.classList.toggle('fa-moon', !darkMode);
        icon.classList.toggle('fa-sun', darkMode);
    }

    /* =========================================================
       Applet lifecycle
       ========================================================= */

    async function init(context) {
        api = context;

        injectStyles();

        await loadDarkMode();

        applyMap();
    }

    function onScan() {
        applyMap();

        hookButton();
    }

    function dispose() {
        document
            .querySelectorAll(`.${BUTTON_CLASS}`)
            .forEach(button => button.remove());

        clearMap();

        document.getElementById(STYLES_ID)?.remove();

        darkMode = false;
        lastButtonSlot = null;
        api = null;
    }

    registerApplet({
        id: 'mapDarkmode',
        name: 'Map Darkmode',
        description:
            'Blendet die Karte ab. Lässt sich wechseln über das Sonne/Mond-Icon in der Toolbox.',
        version: '1.0.0',
        init,
        onScan,
        dispose
    });
})();

/* NicoToolbox – lokal konfigurierbare Fahrzeugvorschläge. */
(function () {
    'use strict';
    const CLASS = 'nicotoolbox-naw-recommended';
    const STYLE = CLASS + '-style';
    const KEY = 'dispatchSuggestionRulesV1';
    const PANEL = 'nicotoolbox-vehicle-rules';
    const BUTTON = 'nicotoolbox-vehicle-rules-button';
    let api, ready = false, rules = [];
    let applied = null;
    function visible(element) { return !!element && element.getClientRects().length > 0; }
    function reset() {
        if (!applied) return;
        const { card, unit, marker } = applied;
        card.classList.remove(CLASS);
        if (marker.parentNode && unit.isConnected && unit.parentNode === marker.parentNode) marker.replaceWith(unit);
        else marker.remove();
        applied = null;
    }
    function positionInList(card, root) {
        const selector = root.querySelector('[data-drag-vehicle-id]') ? '[data-drag-vehicle-id]' : '[data-slot="card"], .border[class*="rounded"]';
        let unit = card;
        // Fahrzeugkarten können in zusätzlichen Drag-/Layout-Containern liegen.
        // Den vollständigen Listeneintrag statt nur dessen Inhalt verschieben.
        while (unit.parentElement && unit.parentElement !== root) {
            const list = unit.parentElement;
            const entries = [...list.children].filter(child => child.matches(selector) || child.querySelector(selector));
            if (entries.length > 1) return { unit, list, first: entries[0] };
            unit = list;
        }
        return null;
    }
    function normalize(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('de'); }
    function matchingRule(root) {
        const texts = [...root.querySelectorAll('[data-mission-keyword], span, p, div')].flatMap(element => {
            if (!visible(element) || element.closest('[data-drag-vehicle-id], .nt-organizer')) return false;
            const text = normalize(element.getAttribute('data-mission-keyword') || element.textContent);
            return text.length <= 140 ? [text] : [];
        }).filter(value => typeof value === 'string');
        return [...rules].sort((a, b) => b.keyword.length - a.keyword.length).find(rule => texts.some(text => text.startsWith(rule.keyword) && /^(?:\s|[·•#–—-]|$)/.test(text.slice(rule.keyword.length))));
    }
    function cardFor(label, root) {
        const explicit = label.closest('[data-drag-vehicle-id]');
        if (explicit && root.contains(explicit)) return explicit;
        let node = label.parentElement;
        for (let depth = 0; node && node !== root && depth < 6; depth++, node = node.parentElement) {
            if (node.classList.contains('border') && [...node.classList].some(name => name.startsWith('rounded'))) return node;
        }
        return null;
    }
    function onScan() {
        if (!ready) return;
        mountSettings();
        const headings = [...document.querySelectorAll('h1,h2,h3,h4')].filter(element => visible(element) && /^(Fahrzeuge alarmieren|Disponieren)$/i.test(element.textContent.trim()));
        let chosen = null, chosenRoot = null;
        for (const heading of headings) {
            let root = heading.closest('[role="dialog"], [data-slot="sheet-content"]');
            if (!root) {
                root = heading.parentElement;
                while (root && root !== document.body && !root.querySelector('input[placeholder*="Suchen"], input[placeholder*="suchen"]')) root = root.parentElement;
            }
            if (!root || root === document.body) continue;
            const rule = matchingRule(root);
            if (!rule) continue;
            const cards = [];
            // Die echte Karte enthält im .font-medium-Container zusätzlich
            // einen Status-Badge (z. B. "2 NAW"). Nur das Typ-Label auslesen.
            for (const label of root.querySelectorAll('[data-vehicle-type], [data-drag-vehicle-id] .font-medium > span.truncate, .font-medium, .font-semibold, h3, h4')) {
                const vehicleType = normalize(label.getAttribute('data-vehicle-type') || label.textContent);
                if (vehicleType !== rule.vehicle && !(rule.vehicle === 'NAW' && vehicleType === 'NOTARZTWAGEN')) continue;
                const card = cardFor(label, root);
                if (card && visible(card) && !card.matches('[disabled], [aria-disabled="true"]') && !cards.includes(card)) cards.push(card);
            }
            chosen = cards[0] || null;
            if (chosen) { chosenRoot = root; break; }
        }
        const placement = chosen ? positionInList(chosen, chosenRoot) : null;
        if (applied?.card === chosen && applied?.unit === placement?.unit && applied?.list === placement?.list) {
            if (placement.first !== applied.unit) placement.list.insertBefore(applied.unit, placement.first);
            if (!chosen.classList.contains(CLASS)) chosen.classList.add(CLASS);
            return;
        }
        reset();
        if (!chosen || !placement) return;
        const { unit, list } = placement;
        const marker = document.createComment('NicoToolbox: ursprüngliche Fahrzeugposition');
        list.insertBefore(marker, unit);
        applied = {card: chosen, unit, list, marker};
        if (placement.first !== unit) list.insertBefore(unit, placement.first);
        chosen.classList.add(CLASS);
    }
    function mountSettings() {
        const slot = api.getAppletSlot();
        if (!slot || slot.querySelector('.' + BUTTON)) return;
        const button = document.createElement('button'); button.type = 'button';
        button.className = BUTTON + ' w-10 h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 flex items-center justify-center cursor-pointer';
        button.title = 'Fahrzeugregeln bearbeiten'; button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fa-solid fa-sliders text-white/80" aria-hidden="true"></i>';
        button.onclick = event => { event.preventDefault(); event.stopPropagation(); openSettings(); };
        api.mountAppletButton(button);
    }
    function closeSettings() { document.getElementById(PANEL)?.remove(); document.querySelector('.' + BUTTON)?.focus(); }
    function openSettings() {
        if (document.getElementById(PANEL)) { closeSettings(); return; }
        const panel = document.createElement('section'); panel.id = PANEL; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Fahrzeugregeln');
        panel.innerHTML = '<header><strong>Fahrzeugregeln</strong><button type="button" data-close aria-label="Schließen">×</button></header><div class="nt-rules-body"><p>Lege fest, welcher Fahrzeugtyp bei einem Stichwort oben steht und golden markiert wird. Verwende den Typnamen aus der Fahrzeugliste, z. B. NAW, RTW oder ELW.</p><div data-rows></div><button type="button" data-add>+ Regel hinzufügen</button><p class="nt-rule-hint">Pro Stichwort eine Regel. Groß-/Kleinschreibung ist egal. Ohne Regeln gibt es keine Vorschläge.</p><div class="nt-rule-actions"><button type="button" data-save>Speichern</button><button type="button" data-cancel>Abbrechen</button></div><p data-status role="status">Änderungen werden erst mit Speichern übernommen.</p></div>';
        const rows = panel.querySelector('[data-rows]');
        function addRow(rule = { keyword: '', vehicle: '' }) {
            const row = document.createElement('div'); row.className = 'nt-rule-row';
            row.innerHTML = '<label>Stichwort<input data-keyword maxlength="60" placeholder="z. B. R1"></label><span aria-hidden="true">→</span><label>Fahrzeugtyp<input data-vehicle maxlength="60" placeholder="z. B. NAW"></label><button type="button" data-remove aria-label="Regel entfernen" title="Regel entfernen">×</button>';
            row.querySelector('[data-keyword]').value = rule.keyword;
            row.querySelector('[data-vehicle]').value = rule.vehicle;
            row.querySelector('[data-remove]').onclick = () => row.remove(); rows.appendChild(row);
            return row;
        }
        rules.forEach(addRow);
        panel.querySelector('[data-add]').onclick = () => addRow().querySelector('input').focus();
        panel.querySelector('[data-close]').onclick = closeSettings;
        panel.querySelector('[data-cancel]').onclick = closeSettings;
        panel.querySelector('[data-save]').onclick = async () => {
            const status = panel.querySelector('[data-status]');
            const next = [...rows.children].map(row => ({ keyword: normalize(row.querySelector('[data-keyword]').value), vehicle: normalize(row.querySelector('[data-vehicle]').value) }));
            if (next.some(rule => !rule.keyword || !rule.vehicle)) { status.textContent = 'Bitte Stichwort und Fahrzeugtyp für jede Regel ausfüllen.'; return; }
            if (new Set(next.map(rule => rule.keyword)).size !== next.length) { status.textContent = 'Jedes Stichwort darf nur einmal vorkommen.'; return; }
            const saveButton = panel.querySelector('[data-save]'); saveButton.disabled = true;
            try {
                await api.dbSet(KEY, next);
                reset(); rules = next; onScan(); status.textContent = 'Regeln lokal gespeichert. Die Fahrzeugliste wurde aktualisiert.';
            } catch (error) { status.textContent = 'Speichern fehlgeschlagen. Deine bisherigen Regeln bleiben aktiv.'; }
            finally { saveButton.disabled = false; }
        };
        panel.addEventListener('click', event => event.stopPropagation());
        panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') closeSettings(); });
        document.body.appendChild(panel); panel.querySelector('input, [data-add]').focus();
    }
    async function init(context) {
        api = context; ready = false;
        const stored = await api.dbGet(KEY);
        if (stored === undefined) rules = [{ keyword: 'R1', vehicle: 'NAW' }];
        else if (Array.isArray(stored) && stored.every(rule => rule && typeof rule.keyword === 'string' && typeof rule.vehicle === 'string')) rules = stored.map(rule => ({ keyword: normalize(rule.keyword), vehicle: normalize(rule.vehicle) })).filter(rule => rule.keyword && rule.vehicle);
        else throw new Error('Ungültige gespeicherte Fahrzeugregeln.');
        ready = true;
        if (document.getElementById(STYLE)) return;
        const style = document.createElement('style'); style.id = STYLE;
        style.textContent = '.' + CLASS + '{border-color:#d4a72c!important;background-color:#fffbeb!important;box-shadow:0 0 0 1px rgba(212,167,44,.20),0 2px 5px rgba(146,104,15,.12)!important;}';
        style.textContent += `#${PANEL}{position:fixed;top:90px;right:32px;z-index:99999;width:min(500px,calc(100vw - 32px));max-height:80vh;overflow:auto;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:12px;box-shadow:0 16px 40px #0006;font:13px/1.5 system-ui;color-scheme:dark}#${PANEL} header{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#27272a}#${PANEL} .nt-rules-body{padding:14px}#${PANEL} p{margin:0 0 12px;color:#a1a1aa}#${PANEL} button{padding:7px 10px;border:1px solid #52525b;border-radius:7px;background:#27272a;color:#f4f4f5;cursor:pointer}#${PANEL} button:disabled{opacity:.5}#${PANEL} .nt-rule-row{display:flex;gap:8px;align-items:end;margin:12px 0}#${PANEL} label{flex:1;min-width:0;font-size:12px}#${PANEL} input{box-sizing:border-box;width:100%;margin-top:4px;padding:8px;background:#111;border:1px solid #52525b;border-radius:7px;color:white}#${PANEL} .nt-rule-hint{margin-top:12px}#${PANEL} .nt-rule-actions{display:flex;gap:8px;margin:14px 0}#${PANEL} [data-save]{border-color:#d4a72c}#${PANEL} [data-status]{margin:0}`;
        document.head.appendChild(style);
    }
    function dispose() { ready = false; reset(); closeSettings(); document.querySelectorAll('.' + BUTTON).forEach(button => button.remove()); document.getElementById(STYLE)?.remove(); }
    registerApplet({id:'dispatchSuggestion',name:'Fahrzeugvorschläge',description:'Stichwörter und bevorzugte Fahrzeugtypen lokal festlegen. Passende Fahrzeuge stehen oben mit goldenem Rahmen.',version:'1.2.0',init,onScan,dispose});
})();


/* NicoToolbox – betätigt den vorhandenen kostenlosen Generierungsbutton. */
(function () {
    'use strict';
    const PANEL = 'nicotoolbox-generator-panel', BUTTON = 'nicotoolbox-generator-button';
    let api, enabled = false, running = false, timer = null, sent = 0, target = 0;
    let startedGame = '', waitingSince = 0, lastMessage = 'Bereit.', initialAlerts = new Set();
    function game() { return location.pathname + location.search; }
    function visible(element) { return !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'; }
    function findTrigger() {
        const candidates = [...document.querySelectorAll('i.fa-fire, i.fa-fire-flame-curved, svg[data-icon="fire"], svg[data-icon="fire-flame-curved"]')]
            .map(icon => icon.closest('button, [role="button"]')).filter(button => {
                if (!visible(button) || button.closest('#nicotoolbox-header-tools')) return false;
                const rect = button.getBoundingClientRect();
                return rect.top >= 0 && rect.top < 120 && rect.left < window.innerWidth / 2;
            });
        const unique = [...new Set(candidates)];
        return unique.length === 1 ? unique[0] : null;
    }
    function alerts() {
        return [...document.querySelectorAll('[role="alert"], [data-sonner-toast][data-type="error"]')]
            .filter(visible).map(element => element.textContent.trim()).filter(Boolean);
    }
    function render() {
        const root = document.getElementById(PANEL); if (!root) return;
        root.querySelector('[data-status]').textContent = lastMessage;
        root.querySelector('progress').max = target || 1;
        root.querySelector('progress').value = sent;
        root.querySelector('[data-count]').textContent = `${sent} von ${target} Klicks ausgelöst`;
        root.querySelector('[data-start]').disabled = running;
        root.querySelector('[data-stop]').disabled = !running;
        root.querySelector('input').disabled = running;
    }
    function stop(message = 'Gestoppt. Bereits ausgelöste Anfragen können noch abgeschlossen werden.') {
        running = false; clearTimeout(timer); timer = null; lastMessage = message; render();
    }
    function schedule(delay = 300) { clearTimeout(timer); timer = setTimeout(step, delay); }
    function step() {
        if (!enabled || !running) return;
        if (game() !== startedGame) { stop('Gestoppt: Die Spielseite wurde gewechselt.'); return; }
        const error = alerts().find(text => !initialAlerts.has(text) && /fehler|error|limit|maximal|nicht möglich|zu viele|fehlgeschlagen/i.test(text));
        if (error) { stop('Gestoppt: ' + error.slice(0, 200)); return; }
        const trigger = findTrigger();
        if (!trigger) { stop('Generierungsbutton nicht eindeutig gefunden. Öffne die Karte und versuche es erneut.'); return; }
        if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true' || trigger.getAttribute('aria-busy') === 'true') {
            if (!waitingSince) waitingSince = Date.now();
            if (Date.now() - waitingSince >= 60000) { stop('Gestoppt: Der Spielbutton ist seit einer Minute gesperrt.'); return; }
            lastMessage = 'Warte auf Freigabe durch das Spiel …'; render(); schedule(200); return;
        }
        waitingSince = 0;
        if (sent >= target) { stop('Fertig: Alle gewünschten Klicks wurden ausgelöst.'); return; }
        try {
            trigger.click(); sent++;
            lastMessage = 'Generierung läuft …'; render(); schedule();
        } catch (error) { stop('Gestoppt: Der Spielbutton konnte nicht betätigt werden.'); }
    }
    function start() {
        if (running) return;
        const input = document.querySelector('#' + PANEL + ' input');
        const count = Number(input?.value);
        if (!Number.isInteger(count) || count < 1 || count > 100) { lastMessage = 'Bitte eine ganze Zahl zwischen 1 und 100 eingeben.'; render(); return; }
        if (!findTrigger()) { lastMessage = 'Der Flammen-Button wurde nicht eindeutig gefunden.'; render(); return; }
        target = count; sent = 0; waitingSince = 0; startedGame = game(); initialAlerts = new Set(alerts()); running = true; step();
    }
    function close() { stop(); document.getElementById(PANEL)?.remove(); document.querySelector('.' + BUTTON)?.focus(); }
    function open() {
        if (document.getElementById(PANEL)) { close(); return; }
        const root = document.createElement('section'); root.id = PANEL; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Einsätze generieren');
        root.innerHTML = `<header><strong>Einsätze generieren</strong><button type="button" data-close aria-label="Schließen">×</button></header><div class="nt-generator-body"><label for="nt-generator-count">Anzahl Einsätze</label><input id="nt-generator-count" type="number" min="1" max="100" step="1" value="5"><p>Ein Klick alle 0,3 Sekunden. Sperren des Spielbuttons werden abgewartet.</p><div><button type="button" data-start>Start</button><button type="button" data-stop>Stopp</button></div><progress value="0" max="1"></progress><div data-count></div><p data-status role="status"></p><small>Der Zähler erfasst ausgelöste Klicks. Ob daraus Einsätze entstehen, entscheidet das Spiel. Schließen stoppt die Serie.</small></div>`;
        root.querySelector('[data-close]').onclick = close;
        root.querySelector('[data-start]').onclick = start;
        root.querySelector('[data-stop]').onclick = () => stop();
        root.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
        root.addEventListener('click', event => event.stopPropagation());
        document.body.appendChild(root); render(); root.querySelector('input').focus();
    }
    function init(context) {
        api = context; enabled = true;
        if (document.getElementById(PANEL + '-style')) return;
        const style = document.createElement('style'); style.id = PANEL + '-style';
        style.textContent = `#${PANEL}{position:fixed;top:90px;right:64px;width:min(340px,calc(100vw - 24px));max-height:80vh;overflow:auto;z-index:99998;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:12px;box-shadow:0 16px 40px #0006;font:13px/1.5 system-ui;color-scheme:dark}#${PANEL} header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#27272a}#${PANEL} .nt-generator-body{padding:14px}#${PANEL} button{padding:6px 12px;border:1px solid #52525b;border-radius:7px;background:#27272a;color:#f4f4f5;cursor:pointer}#${PANEL} button:disabled{opacity:.4;cursor:default}#${PANEL} input{box-sizing:border-box;width:100%;margin:6px 0;padding:9px;background:#111;border:1px solid #52525b;border-radius:7px;color:#fff}#${PANEL} p{margin:10px 0}#${PANEL} small{display:block;color:#a1a1aa}#${PANEL} progress{display:block;width:100%;height:12px;margin:16px 0 6px;accent-color:#f59e0b}`;
        document.head.appendChild(style);
    }
    function onScan() {
        if (running && game() !== startedGame) stop('Gestoppt: Die Spielseite wurde gewechselt.');
        const slot = api.getAppletSlot(); if (!slot || slot.querySelector('.' + BUTTON)) return;
        const button = document.createElement('button'); button.type = 'button';
        button.className = BUTTON + ' w-10 h-10 bg-dark rounded-lg shadow-lg border border-gray-800/80 flex items-center justify-center cursor-pointer';
        button.title = 'Einsätze generieren'; button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fa-solid fa-fire text-white/80" aria-hidden="true"></i>';
        button.onclick = event => { event.preventDefault(); event.stopPropagation(); open(); }; api.mountAppletButton(button);
    }
    function dispose() { enabled = false; close(); document.querySelectorAll('.' + BUTTON).forEach(button => button.remove()); document.getElementById(PANEL + '-style')?.remove(); }
    registerApplet({ id: 'missionGenerator', name: 'Einsätze generieren', description: 'Betätigt den vorhandenen Flammen-Button für eine gewählte Anzahl. Mit Start, Stopp und Fortschritt.', version: '1.0.0', init, onScan, dispose });
})();


    initialize();
})();
