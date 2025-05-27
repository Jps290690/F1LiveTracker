const API_BASE_URL = 'https://api.openf1.org/v1';
const POLLING_INTERVAL = 2000; // ms

// DOM Elements
const eventTitleEl = document.getElementById('event-title');
const timeRemainingEl = document.getElementById('time-remaining');
const lapsInfoEl = document.getElementById('laps-info'); // Etiqueta cambiada en HTML a "Vuelta Actual:"
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
let totalLapsForSession = null; // Variable to store total laps from config
let imagePathsConfig = null;

let driverDataStore = new Map();
let lastKnownRenderedPositions = {};
let activeDriversFromApi = new Set();

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
    if (c.startsWith('soft')) return 'images/soft.svg'; // Changed path
    if (c.startsWith('medium')) return 'images/medium.svg'; // Changed path
    if (c.startsWith('hard')) return 'images/hard.svg'; // Changed path
    if (c.startsWith('wet')) return 'images/wet.svg'; // Changed path
    if (c.startsWith('inter')) return 'images/intermediate.svg'; // Changed path
    return 'images/unknown.svg'; // Changed path
}

async function fetchAllDataForSession(sessionKey) {
    if (!sessionKey) return null;
    try {
        const endpoints = [
            `/position?session_key=${sessionKey}`,
            `/drivers?session_key=${sessionKey}`,
            `/laps?session_key=${sessionKey}`,
            `/car_data?session_key=${sessionKey}`,
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
            totalLapsCompleted: 0, // Initialize total laps
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
        // Update total laps completed based on the highest lap number seen
        if (lap.lap_number > entry.totalLapsCompleted) {
            entry.totalLapsCompleted = lap.lap_number;
        }
        // Also update current_lap_number here to reflect the latest lap data
        if (!entry.lapData || (lap.date && new Date(lap.date) >= new Date(entry.lapData.date || 0))) {
            entry.lapData = lap;
        }
    });

    newDriverDataStore.forEach(entry => {
        entry.allLapsForSession.sort((a, b) => (b.lap_number || 0) - (a.lap_number || 0));
        if (entry.allLapsForSession.length > 0) {
            entry.lapData = entry.allLapsForSession[0];
        }
        if (entry.personalBestLapTime === Infinity) entry.personalBestLapTime = null;
    });

    const associateData = (dataArray, dataKey) => {
        dataArray.forEach(item => {
            let entry = newDriverDataStore.get(item.driver_number);
            if (entry) {
                // For data like car_data, intervals, position, always take the latest by date if multiple entries
                if (!entry[dataKey] || (item.date && new Date(item.date) >= new Date(entry[dataKey].date || 0))) {
                    entry[dataKey] = item;
                } else if (!item.date && !entry[dataKey]) { // For stint data that might not have a top-level date
                    entry[dataKey] = item;
                }
            }
        });
    };
    associateData(apiData.carData, 'carData');

    // For stints, ensure we get the one with the highest stint_number or lap_start for each driver
    const latestStints = new Map();
    apiData.stints.forEach(stint => {
        const existing = latestStints.get(stint.driver_number);
        if (!existing || (stint.stint_number > (existing.stint_number || 0))) {
            latestStints.set(stint.driver_number, stint);
        }
    });
    // Verificamos si el piloto abandonó al terminar su último stint
    latestStints.forEach((stint, driverNum) => {
        const entry = newDriverDataStore.get(driverNum);
        if (entry && stint.lap_end && totalLapsForSession && stint.lap_end === totalLapsForSession) {
            entry.status = 'OUT';
            entry.outReason = 'Stint ended at last lap'; // info opcional para usar después
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
            // If a driver appears in position data but not driverDetails, create a minimal entry
            entry = { driverDetail: { driver_number: pos.driver_number, full_name: `Driver ${pos.driver_number}` }, status: 'ACTIVE', allLapsForSession: [], personalBestLapTime: null, totalLapsCompleted: 0, lastSeenActiveTimestamp: Date.now(), positionData: null, stintData: null, intervalData: null }; newDriverDataStore.set(pos.driver_number, entry);
        }
        // Only update position if new data is more recent or entry has no position data yet
        if (!entry.positionData || (pos.date && new Date(pos.date) >= new Date(entry.positionData.date || 0))) {
            entry.positionData = pos;
        }
        entry.status = 'ACTIVE';
        entry.lastSeenActiveTimestamp = Date.now();
    });

    // Nuevo bloque para calcular el cambio entre la primera y la última posición registrada por piloto
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

    driverDataStore.forEach((oldEntry, driverNum) => {
        const newEntry = newDriverDataStore.get(driverNum);

        // Determine OUT status based on stints and lap difference to leader (if race session)
        const leaderEntry = Array.from(newDriverDataStore.values()).find(entry => entry.positionData?.position === 1);
        const leaderTotalLaps = leaderEntry?.totalLapsCompleted || 0;
        const driverTotalLaps = oldEntry.totalLapsCompleted || 0;

        if (currentSessionDetails?.session_type === 'Race' && oldEntry.stintData?.lap_end !== null && oldEntry.stintData?.lap_end !== undefined && oldEntry.stintData?.lap_end > 0) {
            const lapsAfterLastStint = leaderTotalLaps - (oldEntry.stintData.lap_end + (leaderTotalLaps - driverTotalLaps));
            if (lapsAfterLastStint > 0) {
                oldEntry.status = 'OUT';
                newDriverDataStore.set(driverNum, oldEntry);
                return; // Driver is OUT, no need for other checks
            } else {
                // If stint_end suggests they are still in or just finished, check against last seen timestamp
            }
        }

        if (oldEntry.status === 'ACTIVE' && (!newEntry || newEntry.status !== 'ACTIVE')) {
            if (Date.now() - oldEntry.lastSeenActiveTimestamp > 15000) { // 15-second DNF timeout
                oldEntry.status = 'OUT';
                newDriverDataStore.set(driverNum, oldEntry);
            } else {
                if (newEntry) newEntry.status = 'ACTIVE';
                else {
                    oldEntry.lastSeenActiveTimestamp = Date.now();
                    newDriverDataStore.set(driverNum, oldEntry);
                }
            }
        } else if (oldEntry.status === 'OUT') {
            if (!newEntry) {
                newDriverDataStore.set(driverNum, oldEntry);
            } else {
                newEntry.status = 'OUT';
                // Preserve essential data for OUT drivers if new entry is sparse
                if (!newEntry.lapData && oldEntry.lapData) newEntry.lapData = oldEntry.lapData;
                if (!newEntry.positionData && oldEntry.positionData) newEntry.positionData = oldEntry.positionData;
                if (!newEntry.stintData && oldEntry.stintData) newEntry.stintData = oldEntry.stintData;
            }
        }

    });

    // If session is not a race, clear lap diffs and set status for non-active drivers
    if (currentSessionDetails?.session_type !== 'Race') {
        driverDataStore.forEach(entry => {
            if (entry.status !== 'ACTIVE') entry.status = 'UNKNOWN'; // Or appropriate non-race status
        });
    }

    driverDataStore = newDriverDataStore;

    // --- Build displayArray by processing drivers in position order ---
    // This is crucial for the correct propagation of `currentGlobalLapsDownContext`.
    const driversToProcess = Array.from(driverDataStore.values())
        .filter(entry => entry.driverDetail && (entry.status === 'ACTIVE' || entry.status === 'OUT')) // Process only relevant drivers
        .sort((a, b) => { // Primary sort for processing order
            if (a.status === 'OUT' && b.status !== 'OUT') return 1;
            if (a.status !== 'OUT' && b.status === 'OUT') return -1;
            if (a.status === 'OUT' && b.status === 'OUT') { // Sort OUT drivers by last known position or lap
                return (a.positionData?.position || 99) - (b.positionData?.position || 99) || (b.lapData?.lap_number || 0) - (a.lapData?.lap_number || 0);
            }
            return (a.positionData?.position || 99) - (b.positionData?.position || 99);
        });

    const displayArray = [];
    let currentGlobalLapsDownContext = ""; // Reset context for each processing run

    driversToProcess.forEach(entry => {
        const displayDriver = {
            driver_number: entry.driverDetail.driver_number,
            position: entry.positionData?.position,
            full_name: entry.driverDetail.full_name || 'N/A',
            name_acronym: entry.driverDetail.name_acronym || 'N/A',
            team_name: entry.driverDetail.team_name || 'N/A',
            team_colour: entry.driverDetail.team_colour || '333333',
            status: entry.status,
            current_lap_number: entry.lapData?.lap_number ||
                (entry.status === 'OUT' ? (lastKnownRenderedPositions[entry.driverDetail.driver_number]?.lap_number_for_dnf || '-') : 0)
        };

        // Store first known position if not already stored in the driverDataStore entry
        const driverEntryInStore = driverDataStore.get(displayDriver.driver_number);
        if (driverEntryInStore && driverEntryInStore.firstKnownPosition === undefined && displayDriver.position !== undefined) {
            driverEntryInStore.firstKnownPosition = displayDriver.position;
        }

        // DRS
        displayDriver.drs = { status: '---', class: 'drs-disabled' };
        if (displayDriver.status === 'ACTIVE' && entry.carData?.drs !== undefined) {
            const drsCode = entry.carData.drs;
            if ([10, 12, 14].includes(drsCode)) displayDriver.drs = { status: 'OPEN', class: 'drs-enabled' };
            else if (drsCode === 8) displayDriver.drs = { status: 'AVAIL', class: 'drs-available' };
            else displayDriver.drs = { status: 'OFF', class: 'drs-disabled' };
        } else if (displayDriver.status === 'OUT') {
            displayDriver.drs = { status: 'N/A', class: '' };
        }
        
        // Position Change Info
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

        // Agregamos OUT como info secundaria solo si aplica
        if (
            displayDriver.status === 'OUT' &&
            currentSessionDetails?.session_type === 'Race'
        ) {
            displayDriver.info.secondary = 'OUT';
        }


        // Tyres & Pits
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

        // Position Change
        displayDriver.pos_change = { text: '-', class: 'pos-no-change' };
        const lastRendered = lastKnownRenderedPositions[displayDriver.driver_number];
        if (displayDriver.status === 'ACTIVE' && lastRendered && lastRendered.position !== undefined && displayDriver.position !== undefined && displayDriver.position !== lastRendered.position) {
            const diff = lastRendered.position - displayDriver.position;
            if (diff > 0) displayDriver.pos_change = { text: `▲${diff}`, class: 'pos-up' };
            else if (diff < 0) displayDriver.pos_change = { text: `▼${Math.abs(diff)}`, class: 'pos-down' };
        } else if (displayDriver.status === 'OUT') {
            displayDriver.pos_change = { text: 'OUT', class: 'info-out' };
        }
        if (displayDriver.status === 'ACTIVE' && displayDriver.position !== undefined) {
            lastKnownRenderedPositions[displayDriver.driver_number] = { position: displayDriver.position, lap_number_for_dnf: displayDriver.current_lap_number };
        } else if (displayDriver.status === 'OUT' && (!lastKnownRenderedPositions[displayDriver.driver_number] || lastKnownRenderedPositions[displayDriver.driver_number]?.lap_number_for_dnf === '-')) {
            lastKnownRenderedPositions[displayDriver.driver_number] = {
                position: displayDriver.position || lastRendered?.position,
                lap_number_for_dnf: displayDriver.current_lap_number
            };
        }

        // LAP DIFFERENCE CALCULATION
        // For lap difference calculation, we need the true total laps completed by the leader
        // from the full `driverDataStore`, as `displayArray` is built sequentially.
        const leaderEntryInStore = Array.from(driverDataStore.values()).find(e => e.positionData?.position === 1);
        const leaderTotalCompletedLaps = leaderEntryInStore?.totalLapsCompleted || 0;
        const driverTotalCompletedLaps = entry.totalLapsCompleted || 0;

        // Calculate the difference in completed laps. A positive value means the driver is laps down.
        const lapDifference = leaderTotalCompletedLaps - driverTotalCompletedLaps;

        if (displayDriver.status === 'OUT') {
            displayDriver.lap_difference = '-'; // Or you could show the last known difference: `+${lapDifference}`
        } else if (lapDifference > 0) {
            displayDriver.lap_difference = `+${lapDifference}`;
        }

        // GAP LOGIC (Updated to use total laps)
        displayDriver.gap = { main: '--', secondary: '', lapDiff: '' };
        if (displayDriver.status === 'OUT' && entry.positionData?.position !== 1) { // P1 can also be OUT at the end of the race, but won't have a gap
            displayDriver.gap.interval = 'OUT';
        } else if (entry.positionData?.position === 1) {
            displayDriver.gap.interval = ''; // P1 has no interval or gap to leader
            currentGlobalLapsDownContext = ""; // Reset context for P1
        } else {
            const gapToLeaderVal = entry.intervalData?.gap_to_leader;
            const intervalToAheadVal = entry.intervalData?.interval;


            // Determine the primary value for the GAP column
            if (lapDifference > 0) {
                // Driver is N laps down
                // If there's an interval value, that's the primary display
                if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) {
                    displayDriver.gap.main = formatTime(parseFloat(intervalToAheadVal), true);
                } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                    // If no interval to ahead, show gap to leader (this should be rare when laps down)
                    displayDriver.gap.main = formatTime(parseFloat(gapToLeaderVal), true);
                }

                // If the interval to the car ahead is ALSO laps down, show it as main
                if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && typeof intervalToAheadVal === 'string' && intervalToAheadVal.toUpperCase().includes('LAP')) {
                    displayDriver.gap.main = intervalToAheadVal; // Show interval (e.g., +1 LAP) as main
                }

                // Always show the total lap difference below if the driver is laps down
                displayDriver.gap.lapDiff = `+${lapDifference} Lap${lapDifference > 1 ? 's' : ''}`;

            } else if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) {
                // Driver is on the same lap as the car ahead, show interval to ahead
                displayDriver.gap.main = formatTime(parseFloat(intervalToAheadVal), true);
            } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                // Fallback: If no interval to car ahead, show gap to leader
                displayDriver.gap.main = formatTime(parseFloat(gapToLeaderVal), true);
            } else if (intervalToAheadVal !== null && intervalToAheadVal !== undefined && !isNaN(parseFloat(intervalToAheadVal))) { // This seems redundant based on the logic above
                // If a global laps down context exists from a previous driver (meaning cars ahead are also lapped), show it as secondary
                // displayDriver.gap.main = formatTime(parseFloat(intervalToAheadVal), true); // This line seems incorrect here.
                if (currentGlobalLapsDownContext) {
                    displayDriver.gap.secondary = currentGlobalLapsDownContext;
                }
            } else if (gapToLeaderVal !== null && gapToLeaderVal !== undefined && !isNaN(parseFloat(gapToLeaderVal))) {
                // Fallback: If no interval to car ahead, show gap to leader
                displayDriver.gap.interval = formatTime(parseFloat(gapToLeaderVal), true);
            }
        }
        // Ensure P1 always clears the context regardless
        if (displayDriver.position === 1) currentGlobalLapsDownContext = "";


        // Lap Times
        displayDriver.last_lap_str = '--:--:--';
        if (displayDriver.status === 'OUT') displayDriver.last_lap_str = (entry.lapData?.lap_duration ? formatTime(entry.lapData.lap_duration) : 'OUT');
        else if (entry.lapData?.is_pit_out_lap) displayDriver.last_lap_str = 'OUTLAP';
        else if (entry.lapData?.lap_duration) displayDriver.last_lap_str = formatTime(entry.lapData.lap_duration);

        displayDriver.personal_best_str = entry.personalBestLapTime ? formatTime(entry.personalBestLapTime) : '--:--:--';
        if (displayDriver.status === 'OUT' && !entry.personalBestLapTime) displayDriver.personal_best_str = 'N/A';

        displayArray.push(displayDriver);
    });

    // Final sort for rendering. This uses the `position` from `displayDriver` which was derived from `positionData`.
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
}


function updateStaticHeaderInfo() {
    if (currentMeetingDetails && currentSessionDetails) {
        eventTitleEl.textContent = `${currentMeetingDetails.meeting_name || ""}: ${currentSessionDetails.session_name || ""}`;

        // The flag source and display are handled in the init function
        // No need to do anything with countryFlagImgEl here unless
        // you have other static updates for it based on meeting/session details
        // (which you currently don't seem to have).

    } else {
        eventTitleEl.textContent = 'Cargando evento...';
        countryFlagImgEl.style.display = 'none'; // Ensure hidden if no meeting/session
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
    // Display Current Lap / Total Laps if available
    let lapsDisplay = maxLap > 0 ? maxLap : (isSessionLive ? '0' : '--');
    if (totalLapsForSession !== null) {
        lapsDisplay += ` / ${totalLapsForSession}`;
    }
    lapsInfoEl.textContent = lapsDisplay; // Update the text content

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

    // The lap diff is now integrated into the GAP column, no separate header needed

    if (drivers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8">No hay datos de pilotos para esta sesión.</td></tr>`;
        return;
    }

    drivers.forEach((driver) => {
        const row = tbody.insertRow();
        row.id = `driver-row-${driver.driver_number}`;
        row.className = driver.status === 'OUT' ? 'status-out' : '';
        row.style.borderLeft = `5px solid #${driver.team_colour || '333'}`;

        for (let i = 0; i < 8; i++) row.insertCell(); // 8 cells for the standard columns

        row.cells[0].innerHTML = `<span>${driver.position !== undefined ? driver.position : (driver.status === 'OUT' ? 'OUT' : '--')}</span>`;
        row.cells[1].textContent = driver.driver_number;
        row.cells[2].innerHTML = `<div class="driver-name">${driver.full_name} (${driver.name_acronym})</div><div class="driver-team">${driver.team_name}</div>`;
        row.cells[3].textContent = driver.drs.status;
        row.cells[3].className = driver.drs.class;

        // NEUM cell - corrected "SL:" to "L:"
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
        mainIntervalId = null;
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

    const sessionInfo = await fetch(`${API_BASE_URL}/sessions?session_key=latest`).then(res => res.ok ? res.json() : null).catch(() => null);
    if (!sessionInfo || sessionInfo.length === 0) {
        loadingMessageEl.textContent = 'Error: No se pudo obtener la sesión más reciente.';
        console.error("Failed to fetch latest session info.");
        return;
    }
    currentSessionDetails = sessionInfo[0];
    currentSessionId = currentSessionDetails.session_key;

    if (currentSessionDetails.meeting_key) {
        const meetingInfo = await fetch(`${API_BASE_URL}/meetings?meeting_key=${currentSessionDetails.meeting_key}`).then(res => res.ok ? res.json() : null).catch(() => null);
        if (meetingInfo && meetingInfo.length > 0) {
            currentMeetingDetails = meetingInfo[0];
        }
    }

    // --- Fetch and process session_config.json ---
    try {
        const configResponse = await fetch('session_config.json');
        if (configResponse.ok) {
            const config = await configResponse.json();
            // Find the totalLaps for the current session using the sessionKey
            if (config.sessions && config.sessions[currentSessionId]) {
                const sessionConfig = config.sessions[currentSessionId]; // Store session config

                totalLapsForSession = sessionConfig.totalLaps;
                console.log(`Total laps loaded from config for session ${currentSessionId}: ${totalLapsForSession}`);

                // Get the flag path from the session config and set display
                if (sessionConfig.flag) {
                    countryFlagImgEl.src = sessionConfig.flag; // Set the local flag path
                    countryFlagImgEl.alt = currentMeetingDetails?.country_name || "Country Flag"; // Use country name or default alt
                    countryFlagImgEl.style.display = 'inline-block'; // Show the flag
                    console.log(`Flag path loaded from config for session ${currentSessionId}: ${sessionConfig.flag}`);
                } else {
                    countryFlagImgEl.style.display = 'none'; // Hide the flag if no local flag is specified
                    console.warn(`No specific flag found in session_config.json for session ${currentSessionId}. Hiding flag.`);
                }

            } else {
                countryFlagImgEl.style.display = 'none'; // Hide if no session config found
                console.warn(`No specific totalLaps or flag found in session_config.json for session ${currentSessionId}. Hiding flag.`);
            }
        } else {
            countryFlagImgEl.style.display = 'none'; // Hide if session_config.json fetch failed
            console.warn(`Failed to fetch session_config.json: ${configResponse.status}. Hiding flag.`);
        }
    } catch (error) {
        countryFlagImgEl.style.display = 'none'; // Hide on error
        console.error("Error fetching session_config.json:", error);
    }
    // --- End fetch session_config.json ---


    updateStaticHeaderInfo();

    const now = new Date();
    const sessionEndDate = new Date(currentSessionDetails.date_end);
    isSessionLive = new Date(currentSessionDetails.date_start) <= now && sessionEndDate >= now && currentSessionDetails.session_type === 'Race';

    console.log(`Session: ${currentSessionDetails.session_name || 'N/A'} (Key: ${currentSessionId}), Live: ${isSessionLive}`);

    await mainLoop();

    if (isSessionLive) {
        if (mainIntervalId) clearInterval(mainIntervalId);
        mainIntervalId = setInterval(mainLoop, POLLING_INTERVAL);
    } else {
        console.log("Session is historical or already finished based on initial check.");
    }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', () => {
    if (mainIntervalId) clearInterval(mainIntervalId);
});
