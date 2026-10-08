// IMPORTS - loads tools for reading and writing local JSON files.
const fs = require('fs');
const path = require('path');

// DATA PATH - points to the file where case and coin data is saved.
function resolveDataPath() {
    const configuredPath = process.env.CASE_DATA_PATH || path.join('economy', 'caseData.json');

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(__dirname, configuredPath);
}

const dataPath = resolveDataPath();

// DEFAULT DATA - creates the starting save-file structure.
function createDefaultData() {
    return {
        users: {},
        bossCooldowns: {},
        giveaways: {},
        drops: {
            nextDropAt: 0,
            nextBigDropAt: 0,
        },
    };
}

function normalizeData(data) {
    const normalized = data && typeof data === 'object' ? data : {};

    if (!normalized.users || typeof normalized.users !== 'object') {
        normalized.users = {};
    }

    if (!normalized.bossCooldowns || typeof normalized.bossCooldowns !== 'object') {
        normalized.bossCooldowns = {};
    }

    if (!normalized.drops || typeof normalized.drops !== 'object') {
        normalized.drops = { nextDropAt: 0, nextBigDropAt: 0 };
    }

    if (!normalized.giveaways || typeof normalized.giveaways !== 'object') {
        normalized.giveaways = {};
    }

    if (typeof normalized.drops.nextDropAt !== 'number') {
        normalized.drops.nextDropAt = 0;
    }

    if (typeof normalized.drops.nextBigDropAt !== 'number') {
        normalized.drops.nextBigDropAt = 0;
    }

    Object.keys(normalized.users).forEach(userId => {
        const user = normalized.users[userId];

        if (!user || typeof user !== 'object') {
            normalized.users[userId] = { coins: 0, cases: {} };
            return;
        }

        if (typeof user.coins !== 'number') {
            user.coins = 0;
        }

        if (!user.cases || typeof user.cases !== 'object') {
            user.cases = {};
        }
    });

    return normalized;
}

// DATA FILE SETUP - creates the economy folder and save file if they do not exist.
function ensureDataFile() {
    const dataDirectory = path.dirname(dataPath);

    if (!fs.existsSync(dataDirectory)) {
        fs.mkdirSync(dataDirectory, { recursive: true });
    }

    if (!fs.existsSync(dataPath)) {
        fs.writeFileSync(dataPath, JSON.stringify(createDefaultData(), null, 2));
    }
}

// READ DATA - loads saved user data from the JSON file.
function readData() {
    ensureDataFile();

    try {
        return normalizeData(JSON.parse(fs.readFileSync(dataPath, 'utf8')));
    } catch (error) {
        console.error('Failed to read case economy data:', error);
        return createDefaultData();
    }
}

// WRITE DATA - saves updated user data back into the JSON file.
function writeData(data) {
    ensureDataFile();

    const normalizedData = normalizeData(data);

    if (fs.existsSync(dataPath)) {
        fs.copyFileSync(dataPath, `${dataPath}.bak`);
    }

    fs.writeFileSync(dataPath, JSON.stringify(normalizedData, null, 2));
}

// DATA PATH GETTER - helps startup logs show where owed coins are saved.
function getDataPath() {
    return dataPath;
}

// USER DATA - returns an existing user record or creates a new one.
function getUser(data, userId) {
    if (!data.users[userId]) {
        data.users[userId] = {
            coins: 0,
            cases: {},
        };
    }

    if (typeof data.users[userId].coins !== 'number') {
        data.users[userId].coins = 0;
    }

    if (!data.users[userId].cases) {
        data.users[userId].cases = {};
    }

    return data.users[userId];
}

function getBossCooldown(userId) {
    const data = readData();
    return data.bossCooldowns?.[userId] || 0;
}

function setBossCooldown(userId, cooldownAt) {
    const data = readData();
    data.bossCooldowns = data.bossCooldowns || {};
    data.bossCooldowns[userId] = cooldownAt;
    writeData(data);
    return cooldownAt;
}

function getDropState() {
    const data = readData();
    return data.drops || { nextDropAt: 0, nextBigDropAt: 0 };
}

function setDropState(dropState) {
    const data = readData();
    data.drops = dropState || { nextDropAt: 0, nextBigDropAt: 0 };
    writeData(data);
    return data.drops;
}

function getGiveaways() {
    const data = readData();
    return data.giveaways || {};
}

function getGiveaway(messageId) {
    const giveaways = getGiveaways();
    return giveaways[messageId] || null;
}

function setGiveaway(messageId, giveaway) {
    const data = readData();
    data.giveaways = data.giveaways || {};
    data.giveaways[messageId] = giveaway;
    writeData(data);
    return data.giveaways[messageId];
}

function updateGiveaway(messageId, updater) {
    const data = readData();
    data.giveaways = data.giveaways || {};
    const current = data.giveaways[messageId];

    if (!current) {
        return null;
    }

    const updated = updater({ ...current });

    if (!updated) {
        delete data.giveaways[messageId];
        writeData(data);
        return null;
    }

    data.giveaways[messageId] = updated;
    writeData(data);
    return updated;
}

// ADD CASE - adds one owned case to a user. testing this
function addCase(userId, caseName) {
    const data = readData();
    const user = getUser(data, userId);

    user.cases[caseName] = (user.cases[caseName] || 0) + 1;
    writeData(data);

    return user.cases[caseName];
}

// REMOVE CASE - removes one owned case from a user.
function removeCase(userId, caseName) {
    const data = readData();
    const user = getUser(data, userId);
    const amount = user.cases[caseName] || 0;

    if (amount <= 0) {
        return 0;
    }

    user.cases[caseName] = amount - 1;
    writeData(data);

    return user.cases[caseName];
}

// CASE AMOUNT - checks how many of one case a user owns.
function getCaseAmount(userId, caseName) {
    const data = readData();
    const user = getUser(data, userId);

    return user.cases[caseName] || 0;
}

// ADD COINS - adds coin rewards to a user's balance.
function addCoins(userId, amount) {
    const data = readData();
    const user = getUser(data, userId);

    user.coins += amount;
    writeData(data);

    return user.coins;
}

// REMOVE COINS - deducts coins from a user's balance, allowing it to go negative.
function removeCoins(userId, amount) {
    const data = readData();
    const user = getUser(data, userId);

    user.coins -= amount;
    writeData(data);

    return user.coins;
}

// GET COINS - checks how many coins a user is owed.
function getCoins(userId) {
    const data = readData();
    const user = getUser(data, userId);

    return user.coins;
}

// CLEAR COINS - resets a user's owed coin balance after staff pay it.
function clearCoins(userId) {
    const data = readData();
    const user = getUser(data, userId);
    const previousCoins = user.coins;

    user.coins = 0;
    writeData(data);

    return previousCoins;
}

// EXPORTS - shares storage functions with command files.
module.exports = {
    readData,
    addCase,
    removeCase,
    getCaseAmount,
    addCoins,
    removeCoins,
    getCoins,
    clearCoins,
    getDataPath,
    getBossCooldown,
    setBossCooldown,
    getDropState,
    setDropState,
    getGiveaways,
    getGiveaway,
    setGiveaway,
    updateGiveaway,
};
