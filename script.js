const API_BASE_URL = 'https://api.openf1.org/v1';
const POLLING_INTERVAL = 200; // ms

// DOM Elements
const eventTitleEl = document.getElementById('event-title');
const timeRemainingEl = document.getElementById('time-remaining');
const lapsInfoEl = document.getElementById('laps-info');
const trackStatusEl = document.getElementById('track-status');
const loadingMessageEl = document.getElementById('loading-message');
const standingsTableBodyEl = document.getElementById('standings-table-body');
const countryFlagImgEl = document.getElementById('country-flag');


// Global State
let currentSessionId = null;
let currentMeetingDetails = null;
let currentSessionDetails = null;
let isSessionLive = true; // Assume live initially
let mainIntervalId = null;
let totalLapsForSession = null;
let imagePathsConfig = null;

let driverDataStore = new Map();
let lastKnownRenderedPositions = {};
let activeDriversFromApi = new Set();
let p1LastLapStartDateForCarData = null;

// --- NUEVA FUNCIÓN DE AYUDA PARA FORMATEAR FECHAS ---
/**
 * Formats a JavaScript Date object to YYYY-MM-DDTHH:MM:SS.ffffff+00:00 string.
 * @param {Date} dateObj The Date object to format.
 * @returns {string|null} The formatted date string or null if input is invalid.
 */
function formatDateForApi(dateObj) {
    if (!(dateObj instanceof Date) || isNaN(dateObj.valueOf())) {
        console.error("Invalid date passed to formatDateForApi:", dateObj);
        return null;
    }
    const isoString = dateObj.toISOString(); // Produces YYYY-MM-DDTHH:MM:SS.mmmZ

    // Separar la parte de fecha/hora de los milisegundos y el indicador 'Z'
    const parts = isoString.split('.');
    const dateTimePart = parts[0]; // YYYY-MM-DDTHH:MM:SS

    let milliseconds = "000"; // Por defecto si no hay milisegundos en isoString (improbable para toISOString)
    if (parts.length > 1) {
        milliseconds = parts[1].slice(0, -1); // Extraer 'mmm' de 'mmmZ'
    }

    // Asegurar que los milisegundos tengan 3 dígitos y luego añadir '000' para microsegundos
    const microsecondsPart = milliseconds.padEnd(3, '0') + '000';

    return `${dateTimePart}.${microsecondsPart}+00:00`;
}


function formatTime(value, includeSignIfPositive = false) {
    if (value === null || value === undefined) return '--:--:--';

    if (typeof value === 'string') {
        if (value.toUpperCase().includes('LAP') || isNaN(parseFloat(value)))
            return value;
        value = parseFloat(value);
    }

    if (isNaN(value)) return '--:--:--';

    const absValue = Math.abs(value);
    let sign = "";

    if (value < -0.0001) {
        sign = "-";
    } else if (includeSignIfPositive && value > 0.0001) {
        sign = "+";
    }

    const minutes = Math.floor(absValue / 60);
    const seconds = absValue % 60;
    const s = String(Math.floor(seconds)).padStart(2, '0');
    const ms = String(Math.round((seconds - Math.floor(seconds)) * 1000)).padStart(3, '0');

    if (minutes === 0 && absValue < 60) return `${sign}${s}.${ms}`;
    return `${sign}${String(minutes).padStart(2, '0')}:${s}.${ms}`;
}


function getTyreImg(compound) {
    const c = String(compound).toLowerCase();
    if (c.startsWith('soft')) return 'images/soft.svg';
    if (c.startsWith('medium')) return 'images/medium.svg';
    if (c.startsWith('hard')) return 'images/hard.svg';
    if (c.startsWith('wet')) return 'images/wet.svg';
    if (c.startsWith('inter')) return 'images/intermediate.svg';
    return 'images/unknown.svg';
}

async function fetchAllDataForSession(sessionKey) {
    if (!sessionKey) return null;
    try {
        let carDataDateParam = '';
        if (p1LastLapStartDateForCarData) {
            // La fecha de start_date del endpoint /laps ya está en el formato correcto
            // Ejemplo: "2023-09-16T13:59:07.606000+00:00"
            carDataDateParam = `&date=>=${p1LastLapStartDateForCarData}`;
            console.log("Using P1 lap start_date for car_data (already formatted):", p1LastLapStartDateForCarData);
        } else {
            // Fallback: tiempo actual - 1 minuto, formateado con la nueva función
            const fallbackDate = new Date(Date.now() - 60 * 1000);
            const formattedFallbackDate = formatDateForApi(fallbackDate);
            if (formattedFallbackDate) {
                carDataDateParam = `&date=>=${formattedFallbackDate}`;
            }
            console.log("P1 lap start_date not available, using fallback for car_data date:", formattedFallbackDate);
        }

        const endpoints = [
            `/position?session_key=${sessionKey}`,
            `/drivers?session_key=${sessionKey}`,
            `/laps?session_key=${sessionKey}`,
            `/car_data?session_key=${sessionKey}${carDataDateParam}`,
            `/stints?session_key=${sessionKey}`,
            `/intervals?session_key=${sessionKey}`,
            `/track_status?session_key=${sessionKey}`
        ];

        const responses = await Promise.all(
            endpoints.map(ep => fetch(`${API_BASE_URL}${ep}`)
                .then(res => res.ok ? res.json() : Promise.resolve([]))
                .catch(() => { console.warn(`Fetch failed for ${ep}`); return []; })
            )
        );

        return {
            positions: responses[0],
            driverDetails: responses[1],
            allLaps: responses[2],
            carData: responses[3],
            stints: responses[4],
            intervals: responses[5],
            trackStatus: responses[6],
        };
    } catch (error) {
        console.error('Error fetching all data:', error);
        return null;
    }
}

function processAndBuildDisplayData(apiData) {
    if (!apiData) return [];

    const newDriverDataStore = new Map();
    activeDriversFromApi.clear();

    apiData.driverDetails.forEach(detail => {
        newDriverDataStore.set(detail.driver_number, {
            driverDetail: detail,
            status: 'UNKNOWN',
            allLapsForSession: [],
            personalBestLapTime: Infinity,
            totalLapsCompleted: 0,
            lastSeenActiveTimestamp: driverDataStore.get(detail.driver_number)?.lastSeenActiveTimestamp || 0
        });
    });

    apiData.allLaps.forEach(lap => {
        let entry = newDriverDataStore.get(lap.driver_number);
        if (!entry) {
            entry = { driverDetail: { driver_number: lap.driver_number, full_name: `Driver ${lap.driver_number}` }, status: 'UNKNOWN', allLapsForSession: [], personalBestLapTime: Infinity, totalLapsCompleted: 0, lastSeenActiveTimestamp: 0 };
            newDriverDataStore.set(lap.driver_number, entry);
        }
        entry.allLapsForSession.push(lap);
        if (lap.lap_duration && lap.lap_duration < entry.personalBestLapTime) {
            entry.personalBestLapTime = lap.lap_duration;
        }
        if (lap.lap_number > entry.totalLapsCompleted) {
            entry.totalLapsCompleted = lap.lap_number;
        }
        // Almacenar el objeto de la vuelta más reciente para el piloto
        // Comparar por lap_number y luego por date_start si los números de vuelta son iguales o no disponibles
        if (!entry.lapData ||
            (lap.lap_number && entry.lapData.lap_number && lap.lap_number > entry.lapData.lap_number) ||
            (lap.lap_number && !entry.lapData.lap_number) ||
            (lap.lap_number === entry.lapData.lap_number && lap.date_start && entry.lapData.date_start && new Date(lap.date_start) > new Date(entry.lapData.date_start))
        ) {
            entry.lapData = lap;
        }
    });

    newDriverDataStore.forEach(entry => {
        entry.allLapsForSession.sort((a, b) => (b.lap_number || 0) - (a.lap_number || 0));
        // Asegurar que lapData es la vuelta más reciente si no se estableció correctamente antes
        if (entry.allLapsForSession.length > 0) {
            if (!entry.lapData || (entry.allLapsForSession[0].lap_number > (entry.lapData.lap_number || 0))) {
                entry.lapData = entry.allLapsForSession[0];
            }
        }
        if (entry.personalBestLapTime === Infinity) entry.personalBestLapTime = null;
    });

    const associateData = (dataArray, dataKey) => {
        dataArray.forEach(item => {
            let entry = newDriverDataStore.get(item.driver_number);
            if (entry) {
                if (!entry[dataKey] || (item.date && new Date(item.date) >= new Date(entry[dataKey].date || 0))) {
                    entry[dataKey] = item;
                } else if (!item.date && !entry[dataKey]) {
                    entry[dataKey] = item;
                }
            }
        });
    };
    associateData(apiData.carData, 'carData');

    const latestStints = new Map();
    apiData.stints.forEach(stint => {
        const existing = latestStints.get(stint.driver_number);
        if (!existing || (stint.stint_number > (existing.stint_number || 0))) {
            latestStints.set(stint.driver_number, stint);
        }
    });
    latestStints.forEach(stint => {
        let entry = newDriverDataStore.get(stint.driver_number);
        if (entry) entry.stintData = stint;
    });

    associateData(apiData.intervals, 'intervalData');

    apiData.positions.forEach(pos => {
        activeDriversFromApi.add(pos.driver_number);
        let entry = newDriverDataStore.get(pos.driver_number);
        if (!entry) {
            entry = { driverDetail: { driver_number: pos.driver_number, full_name: `Driver ${pos.driver_number}` }, status: 'ACTIVE', allLapsForSession: [], personalBestLapTime: null, totalLapsCompleted: 0, lastSeenActiveTimestamp: Date.now(), positionData: null, stintData: null, intervalData: null }; newDriverDataStore.set(pos.driver_number, entry);
        }
        if (!entry.positionData || (pos.date && new Date(pos.date) >= new Date(entry.positionData.date || 0))) {
            entry.positionData = pos;
        }
        entry.status = 'ACTIVE';
        entry.lastSeenActiveTimestamp = Date.now();
    });

    const positionHistoryMap = new Map();
    apiData.positions.forEach(pos => {
        const driverNum = pos.driver_number;
        if (!positionHistoryMap.has(driverNum)) {
            positionHistoryMap.set(driverNum, { first: pos.position, last: pos.position });
        } else {
            const existing = positionHistoryMap.get(driverNum);
            if (new Date(pos.date) < new Date(driverDataStore.get(driverNum)?.firstPositionDate || Infinity)) {
                existing.first = pos.position;
            }
            if (new Date(pos.date) > new Date(driverDataStore.get(driverNum)?.lastPositionDate || 0)) {
                existing.last = pos.position;
            }
        }
    });

    driverDataStore = newDriverDataStore;

    const driversToProcess = Array.from(driverDataStore.values())
        .filter(entry => entry.driverDetail && (entry.status === 'ACTIVE' || entry.status === 'OUT'))
        .sort((a, b) => {
            if (a.status === 'OUT' && b.status !== 'OUT') return 1;
            if (a.status !== 'OUT' && b.status === 'OUT') return -1;
            if (a.status === 'OUT' && b.status === 'OUT') {
                return (a.positionData?.position || 99) - (b.positionData?.position || 99) || (b.lapData?.lap_number || 0) - (a.lapData?.lap_number || 0);
            }
            return (a.positionData?.position || 99) - (b.positionData?.position || 99);
        });

    const displayArray = [];
    let currentGlobalLapsDownContext = "";

    driversToProcess.forEach(entry => {
        const displayDriver = {
            driver_number: entry.driverDetail.driver_number,
            position: entry.positionData?.position,
            full_name: entry.driverDetail.full_name || 'N/A',
            name_acronym: entry.driverDetail.name_acronym || 'N/A',
            team_name: entry.driverDetail.team_name || 'N/A',
            team_colour: entry.driverDetail.team_colour || '333333',
            status: entry.status,
            current_lap_number: entry.lapData?.lap_number
        };

        const driverEntryInStore = driverDataStore.get(displayDriver.driver_number);
        if (driverEntryInStore && driverEntryInStore.firstKnownPosition === undefined && displayDriver.position !== undefined) {
            driverEntryInStore.firstKnownPosition = displayDriver.position;
        }

        displayDriver.drs = { status: '---', class: 'drs-disabled' };
        if (displayDriver.status === 'ACTIVE' && entry.carData?.drs !== undefined) {
            const drsCode = entry.carData.drs;
            if ([10, 12, 14].includes(drsCode)) displayDriver.drs = { status: 'OPEN', class: 'drs-enabled' };
            else if (drsCode === 8) displayDriver.drs = { status: 'AVAIL', class: 'drs-available' };
            else displayDriver.drs = { status: 'OFF', class: 'drs-disabled' };
        }

        const posHistory = positionHistoryMap.get(displayDriver.driver_number);
        displayDriver.info = { text: '', class: '', secondary: '' };
        if (posHistory && posHistory.first !== undefined && posHistory.last !== undefined) {
            const diff = posHistory.first - posHistory.last;
            if (diff > 0) {
                displayDriver.info.text = `▲${diff}`;
                displayDriver.info.class = 'pos-up';
            } else if (diff < 0) {
                displayDriver.info.text = `▼${Math.abs(diff)}`;
                displayDriver.info.class = 'pos-down';
            } else {
                displayDriver.info.text = '—';
                displayDriver.info.class = 'pos-no-change';
            }
        } else {
            displayDriver.info.text = 'N/A';
            displayDriver.info.class = '';
        }

        displayDriver.compound = 'N/A';
        displayDriver.laps_on_current_set = '--';
        displayDriver.pit_stop_count = '-';
        if (entry.stintData) {
            displayDriver.compound = entry.stintData.compound || 'N/A';
            displayDriver.pit_stop_count = entry.stintData.stint_number ? Math.max(0, entry.stintData.stint_number - 1) : '-';
            if (entry.lapData && entry.stintData.lap_start !== undefined && entry.lapData.lap_number !== undefined) {
                const lapsOnSet = (entry.lapData.lap_number - entry.stintData.lap_start) + 1;
                displayDriver.laps_on_current_set = lapsOnSet > 0 ? lapsOnSet : (entry.stintData.tyre_age_at_start !== undefined ? entry.stintData.tyre_age_at_start : '--');
            } else if (entry.stintData.tyre_age_at_start !== undefined) {
                displayDriver.laps_on_current_set = entry.stintData.tyre_age_at_start;
            }
        }
        if (displayDriver.status === 'OUT' && displayDriver.laps_on_current_set === '--' && entry.stintData?.tyre_age_at_start) {
            displayDriver.laps_on_current_set = entry.stintData.tyre_age_at_start;
        }

        const leaderEntryInStore = Array.from(driverDataStore.values()).find(e => e.positionData?.position === 1);
        const leaderTotalCompletedLaps = leaderEntryInStore?.totalLapsCompleted || 0;
        const driverTotalCompletedLaps = entry.totalLapsCompleted || 0;
        const lapDifference = leaderTotalCompletedLaps - driverTotalCompletedLaps;
        if (lapDifference > 0) {
            displayDriver.lap_difference = `+${lapDifference}`;
        }

        displayDriver.gap = { main: '--', secondary: '', lapDiff: '' };
        if (entry.positionData?.position === 1) {
            displayDriver.gap.interval = '';
            currentGlobalLapsDownContext = "";
        } else {
            const gapToLeaderVal = entry.intervalData?.gap_to_leader;
            const intervalToAheadVal = entry.intervalData?.interval;
            if (lapDifference > 0) {
                if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) {
                    displayDriver.gap.main = formatTime(parseFloat(intervalToAheadVal), true);
                } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                    displayDriver.gap.main = formatTime(parseFloat(gapToLeaderVal), true);
                }
                if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && typeof intervalToAheadVal === 'string' && intervalToAheadVal.toUpperCase().includes('LAP')) {
                    displayDriver.gap.main = intervalToAheadVal;
                }
                displayDriver.gap.lapDiff = `+${lapDifference} Lap${lapDifference > 1 ? 's' : ''}`;
            } else if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) {
                displayDriver.gap.main = formatTime(parseFloat(intervalToAheadVal), true);
            } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                displayDriver.gap.main = formatTime(parseFloat(gapToLeaderVal), true);
            } else if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) {
                if (currentGlobalLapsDownContext) {
                    displayDriver.gap.secondary = currentGlobalLapsDownContext;
                }
            } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                displayDriver.gap.interval = formatTime(parseFloat(gapToLeaderVal), true);
            }
        }
        if (displayDriver.position === 1) currentGlobalLapsDownContext = "";

        displayDriver.last_lap_str = '--:--:--';
        if (entry.lapData?.is_pit_out_lap) displayDriver.last_lap_str = 'OUTLAP';
        else if (entry.lapData?.lap_duration) displayDriver.last_lap_str = formatTime(entry.lapData.lap_duration);
        displayDriver.personal_best_str = entry.personalBestLapTime ? formatTime(entry.personalBestLapTime) : '--:--:--';
        displayArray.push(displayDriver);
    });

    displayArray.sort((a, b) => {
        if (a.status === 'OUT' && b.status !== 'OUT') return 1;
        if (a.status !== 'OUT' && b.status === 'OUT') return -1;
        if (a.status === 'OUT' && b.status === 'OUT') {
            const lapsDiff = (b.current_lap_number === '-' ? 0 : b.current_lap_number || 0) - (a.current_lap_number === '-' ? 0 : a.current_lap_number || 0);
            if (lapsDiff !== 0) return lapsDiff;
            return (a.position || 99) - (b.position || 99);
        }
        return (a.position || 99) - (b.position || 99);
    });

    updateGeneralHeaderDisplay(apiData.trackStatus, displayArray);
    renderTableDOM(displayArray);

    if (isSessionLive) {
        const leaderEntry = Array.from(driverDataStore.values()).find(
            (entry) => entry.positionData?.position === 1
        );
        if (leaderEntry && leaderEntry.lapData && leaderEntry.lapData.start_date) {
            // start_date de la API /laps ya tiene el formato YYYY-MM-DDTHH:MM:SS.ffffff+00:00
            p1LastLapStartDateForCarData = leaderEntry.lapData.start_date;
            // console.log("Updated p1LastLapStartDateForCarData for next fetch:", p1LastLapStartDateForCarData);
        } else {
            p1LastLapStartDateForCarData = null;
            // console.log("P1 or lapData.start_date not found, p1LastLapStartDateForCarData cleared.");
        }
    } else {
        p1LastLapStartDateForCarData = null;
    }
}


function updateStaticHeaderInfo() {
    if (currentMeetingDetails && currentSessionDetails) {
        eventTitleEl.textContent = `${currentMeetingDetails.meeting_name || ""}: ${currentSessionDetails.session_name || ""}`;
    } else {
        eventTitleEl.textContent = 'Cargando evento...';
        countryFlagImgEl.style.display = 'none';
    }
}


function updateGeneralHeaderDisplay(trackStatusData, drivers) {
    if (isSessionLive && currentSessionDetails) {
        const now = new Date();
        const sessionEndDate = new Date(currentSessionDetails.date_end);
        if (sessionEndDate > now) {
            const remainingSeconds = Math.max(0, Math.floor((sessionEndDate - now) / 1000));
            const h = String(Math.floor(remainingSeconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((remainingSeconds % 3600) / 60)).padStart(2, '0');
            const s = String(remainingSeconds % 60).padStart(2, '0');
            timeRemainingEl.textContent = `${h}:${m}:${s}`;
        } else {
            timeRemainingEl.textContent = 'Finalizado';
            isSessionLive = false;
            if (mainIntervalId) clearInterval(mainIntervalId);
            console.log("Session ended (time). Polling stopped.");
        }
    } else if (!isSessionLive) {
        timeRemainingEl.textContent = 'Finalizado';
    }

    let maxLap = 0;
    if (drivers) {
        drivers.forEach(d => {
            if (d.status === 'ACTIVE' && d.current_lap_number > maxLap) maxLap = d.current_lap_number;
        });
    }
    let lapsDisplay = maxLap > 0 ? maxLap : (isSessionLive ? '0' : '--');
    if (totalLapsForSession !== null) {
        lapsDisplay += ` / ${totalLapsForSession}`;
    }
    lapsInfoEl.textContent = lapsDisplay;

    if (trackStatusData && trackStatusData.length > 0) {
        trackStatusEl.textContent = trackStatusData[trackStatusData.length - 1].status_type;
    } else {
        trackStatusEl.textContent = isSessionLive ? 'Desconocido' : 'Finalizado';
    }
}

function renderTableDOM(drivers) {
    if (loadingMessageEl.style.display !== 'none') loadingMessageEl.style.display = 'none';
    const tbody = standingsTableBodyEl;
    tbody.innerHTML = '';
    if (drivers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8">No hay datos de pilotos para esta sesión.</td></tr>`;
        return;
    }
    drivers.forEach((driver) => {
        const row = tbody.insertRow();
        row.id = `driver-row-${driver.driver_number}`;
        row.style.borderLeft = `5px solid #${driver.team_colour || '333'}`;
        for (let i = 0; i < 8; i++) row.insertCell();
        row.cells[0].innerHTML = `<span>${driver.position !== undefined ? driver.position : (driver.status === 'OUT' ? 'OUT' : '--')}</span>`;
        row.cells[1].textContent = driver.driver_number;
        row.cells[2].innerHTML = `<div class="driver-name">${driver.full_name} (${driver.name_acronym})</div><div class="driver-team">${driver.team_name}</div>`;
        row.cells[3].textContent = driver.drs.status;
        row.cells[3].className = driver.drs.class;
        row.cells[4].innerHTML = `
            <div class="tyre-cell-layout">
                <div class="tyre-icon-container">
                    <img src="${getTyreImg(driver.compound)}" alt="${driver.compound || 'N/A'}" title="${driver.compound || 'N/A'}">
                </div>
                <div class="tyre-details-text">
                    <span class="tyre-stint-laps">L: ${driver.laps_on_current_set}</span>
                    <span class="tyre-pit-stops">P: ${driver.pit_stop_count}</span>
                </div>
            </div>`;
        row.cells[5].innerHTML = `
            <div>
                <span class="${driver.info.class}">${driver.info.text}</span>
                ${driver.info.secondary ? `<div style="font-size: 0.75em; color: #888;">${driver.info.secondary}</div>` : ''}
            </div>`;
        row.cells[6].innerHTML = `
            ${driver.gap.interval ? `<span class="gap-interval">${driver.gap.interval}</span>` : ''}
            <span class="gap-main">${driver.gap.main}</span>
            ${driver.gap.lapDiff ? `<span class="gap-secondary-info">${driver.gap.lapDiff}</span>` : ''}
        `;
        row.cells[7].innerHTML = `<span class="lap-time-main">${driver.last_lap_str}</span>
        <span class="lap-time-personal-best">${driver.personal_best_str}</span>`;
    });
}

async function mainLoop() {
    if (!currentSessionId) {
        console.log("No session ID, main loop terminated.");
        if (mainIntervalId) clearInterval(mainIntervalId);
        return;
    }
    if (!isSessionLive && currentSessionDetails) {
        console.log("Session is not live. Fetching data once and stopping periodic updates.");
        if (mainIntervalId) clearInterval(mainIntervalId);
        mainIntervalId = null; // Asegurarse de que el ID del intervalo se borra
        const apiData = await fetchAllDataForSession(currentSessionId);
        if (apiData) processAndBuildDisplayData(apiData);
        else updateGeneralHeaderDisplay(null, []);
        return;
    }

    const apiData = await fetchAllDataForSession(currentSessionId);
    if (apiData) processAndBuildDisplayData(apiData);
}

async function init() {
    console.log('Initializing F1 Live Tracker...');
    loadingMessageEl.style.display = 'block';
    standingsTableBodyEl.innerHTML = `<tr><td colspan="8">Cargando datos iniciales...</td></tr>`;

    try {
        const sessionInfoResponse = await fetch(`${API_BASE_URL}/sessions?session_key=latest`);
        if (!sessionInfoResponse.ok) throw new Error(`Failed to fetch latest session: ${sessionInfoResponse.status}`);
        const sessionInfo = await sessionInfoResponse.json();

        if (!sessionInfo || sessionInfo.length === 0) {
            loadingMessageEl.textContent = 'Error: No se pudo obtener la sesión más reciente.';
            console.error("No latest session info found.");
            return;
        }
        currentSessionDetails = sessionInfo[0];
        currentSessionId = currentSessionDetails.session_key;

        if (currentSessionDetails.meeting_key) {
            const meetingInfoResponse = await fetch(`${API_BASE_URL}/meetings?meeting_key=${currentSessionDetails.meeting_key}`);
            if (meetingInfoResponse.ok) {
                const meetingInfo = await meetingInfoResponse.json();
                if (meetingInfo && meetingInfo.length > 0) {
                    currentMeetingDetails = meetingInfo[0];
                }
            } else {
                console.warn(`Failed to fetch meeting details: ${meetingInfoResponse.status}`);
            }
        }

        try {
            const configResponse = await fetch('session_config.json');
            if (configResponse.ok) {
                const config = await configResponse.json();
                if (config.sessions && config.sessions[currentSessionId]) {
                    const sessionConfig = config.sessions[currentSessionId];
                    totalLapsForSession = sessionConfig.totalLaps;
                    if (sessionConfig.flag) {
                        countryFlagImgEl.src = sessionConfig.flag;
                        countryFlagImgEl.alt = currentMeetingDetails?.country_name || "Country Flag";
                        countryFlagImgEl.style.display = 'inline-block';
                    } else {
                        countryFlagImgEl.style.display = 'none';
                    }
                } else {
                    countryFlagImgEl.style.display = 'none';
                }
            } else {
                countryFlagImgEl.style.display = 'none';
                console.warn(`Failed to fetch session_config.json: ${configResponse.status}.`);
            }
        } catch (error) {
            countryFlagImgEl.style.display = 'none';
            console.error("Error processing session_config.json:", error);
        }

        updateStaticHeaderInfo();

        const now = new Date();
        const sessionStartDate = new Date(currentSessionDetails.date_start); // Necesario para verificar si ya empezó
        const sessionEndDate = new Date(currentSessionDetails.date_end);
        // Considerar una sesión "live" si session_type es 'Race' (o lo que definas como "en vivo"),
        // y la hora actual está entre el inicio y el fin de la sesión.
        isSessionLive = (currentSessionDetails.session_type === 'Race' ||
            currentSessionDetails.session_type === 'Qualifying' || // Ajusta según los tipos de sesión que quieras considerar "live"
            currentSessionDetails.session_type === 'Sprint Qualifying' ||
            currentSessionDetails.session_type === 'Sprint' ||
            currentSessionDetails.session_type === 'Practice') && // Podrías querer prácticas también
            sessionStartDate <= now &&
            sessionEndDate >= now;


        console.log(`Session: ${currentSessionDetails.session_name || 'N/A'} (Key: ${currentSessionId}), Actual Live Status: ${isSessionLive}`);

        await mainLoop();

        if (isSessionLive) {
            if (mainIntervalId) clearInterval(mainIntervalId);
            mainIntervalId = setInterval(mainLoop, POLLING_INTERVAL);
        } else {
            console.log("Session is historical or not a type considered live. Data fetched once.");
            // mainLoop ya fue llamado una vez, no se necesita intervalo.
            // Asegurarse de que el timeRemainingEl muestre 'Finalizado' si no es live.
            if (sessionEndDate <= now && timeRemainingEl.textContent !== 'Finalizado') {
                timeRemainingEl.textContent = 'Finalizado';
            } else if (sessionStartDate > now) {
                timeRemainingEl.textContent = 'Not Started'; // O algo similar
            }
        }

    } catch (error) {
        loadingMessageEl.textContent = `Error al inicializar: ${error.message}`;
        console.error("Initialization error:", error);
    }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
    if (mainIntervalId) clearInterval(mainIntervalId);
});
