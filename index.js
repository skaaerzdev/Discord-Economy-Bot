// ENV SETUP - loads values from .env into process.env.
require('dotenv').config();

// NODE IMPORTS - loads local file and path helpers.
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./caseStore');
const { startDropScheduler, handleClaimButton } = require('./commands/drops');
const { startGiveawayScheduler, handleGiveawayInteraction } = require('./commands/giveaway');

// APP PATHS - anchors folders to this file so Linux hosts do not depend on the launch directory.
const ROOT_DIR = __dirname;
const COMMANDS_DIR = process.env.COMMANDS_DIR
    ? path.resolve(process.env.COMMANDS_DIR)
    : path.join(ROOT_DIR, 'commands');
const MODERATION_DIR = path.join(ROOT_DIR, 'moderation');

// REQUIRED ENV - stops the bot if an important .env value is missing.
function requireEnv(name) {
    if (!process.env[name]) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
}

// DISCORD ID CHECK - makes sure configured Discord IDs look valid.
function validateSnowflake(name, required = true) {
    const value = process.env[name];

    if (!value && !required) {
        return;
    }

    if (!value || !/^\d{17,20}$/.test(value)) {
        throw new Error(`${name} must be a Discord ID with 17 to 20 digits.`);
    }
}

// COMMAND DIRECTORY CHECK - gives a useful hosting error instead of a raw ENOENT stack.
function getCommandFiles() {
    if (!fs.existsSync(COMMANDS_DIR)) {
        throw new Error(
            `Command folder not found at ${COMMANDS_DIR}. ` +
            'On Pebble Host, upload the whole project including the commands folder, ' +
            'or set COMMANDS_DIR to the folder that contains your command .js files.'
        );
    }

    const commandFiles = fs.readdirSync(COMMANDS_DIR)
        .filter(file => file.endsWith('.js'));

    if (commandFiles.length === 0) {
        throw new Error(`No command .js files found in ${COMMANDS_DIR}.`);
    }

    return commandFiles;
}

// MODERATION COMMAND FILES - gets command files from moderation folder if it exists
function getModerationFiles() {
    if (!fs.existsSync(MODERATION_DIR)) {
        return [];
    }

    return fs.readdirSync(MODERATION_DIR)
        .filter(file => file.endsWith('.js'));
}

// COMMAND IMPORT - loads one command module by file name.
function loadCommandFile(file) {
    return require(path.join(COMMANDS_DIR, file));
}

// SLASH COMMAND IMPORTS - loads Discord REST tools for command registration.
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// DEPLOY COMMANDS - sends all slash command definitions to Discord.
const deployCommands = async commandCollection => {
    try {
        // COMMAND LIST - reuses already-loaded commands so startup only imports each file once.
        const commands = Array.from(commandCollection.values()).map(command => command.data.toJSON());

        // REST CLIENT - authenticates command deployment with the bot token.
        const rest = new REST().setToken(process.env.BOT_TOKEN);

        // DEPLOY TARGET - uses guild commands during development or global commands otherwise.
        const isGuildRegistration = Boolean(process.env.GUILD_ID);
        const route = isGuildRegistration
            ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
            : Routes.applicationCommands(process.env.CLIENT_ID);

        console.log(`Started refreshing ${commands.length} application slash commands (${isGuildRegistration ? `guild ${process.env.GUILD_ID}` : 'global'})`);

        // DISCORD UPDATE - replaces Discord's slash commands with the local command list.
        await rest.put(route, { body: commands });

        console.log(`Successfully reloaded commands`);
    } catch (error) {
        if (error.code === 50001) {
            console.error(
                'Failed to deploy slash commands: Missing Access (50001).\n' +
                'This means the bot lacks the "applications.commands" scope in your Discord server.\n' +
                'Fix: Go to Discord Developer Portal > OAuth2 > URL Generator, check "applications.commands",\n' +
                'regenerate the invite URL, and re-invite the bot to your server.'
            );
        } else {
            console.error(`Error deploying command`, error);
        }
    }
};

// DISCORD CLIENT IMPORTS - loads the client, intents, events, and helper classes.
const {
    Client,
    GatewayIntentBits,
    Partials,
    Collection,
    ActivityType,
    PresenceUpdateStatus,
    Events,
} = require('discord.js');

// CLIENT SETUP - creates the bot client and enables needed Discord events.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.GuildMember
    ]
});

// COMMAND CACHE - stores loaded command files by command name.
client.commands = new Collection();

// COMMAND FILES - finds every JavaScript command file in the commands folder.
const commandsFiles = getCommandFiles();
const moderationFiles = getModerationFiles();

// COMMAND LOADER - requires each command file and adds it to the command cache.
for (const file of commandsFiles) {
    const filePath = path.join(COMMANDS_DIR, file);

    let command;

    try {
        command = loadCommandFile(file);
    } catch (loadError) {
        console.error(`Failed to load command file ${filePath}:`, loadError.message);
        continue;
    }

    if ('data' in command && 'execute' in command) {
        const commandData = command.data.toJSON();
        // COMMAND REGISTER - saves the command so slash and prefix handlers can run it.
        client.commands.set(commandData.name, command);
        console.log(`Loaded command: ${commandData.name}`);

        // ALIAS REGISTRATION - registers alias commands for both prefix and slash usage.
        if (command.aliases && Array.isArray(command.aliases)) {
            for (const alias of command.aliases) {
                try {
                    const aliasCommand = {
                        data: new SlashCommandBuilder()
                            .setName(alias)
                            .setDescription(commandData.description || command.data.description),
                        execute: command.execute.bind(command),
                    };
                    client.commands.set(alias, aliasCommand);
                    console.log(`Loaded alias: ${alias} -> ${commandData.name}`);
                } catch (aliasError) {
                    console.error(`Failed to register alias "${alias}" for ${commandData.name}:`, aliasError.message);
                }
            }
        }
    } else {
        console.log(`The command ${filePath} is missing a required "data" or "execute" property`);
    }
}

// MODERATION COMMAND LOADER - requires each moderation command file
for (const file of moderationFiles) {
    const filePath = path.join(MODERATION_DIR, file);
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
        const commandData = command.data.toJSON();
        // COMMAND REGISTER - saves the command so slash and prefix handlers can run it.
        client.commands.set(commandData.name, command);
        console.log(`Loaded moderation command: ${commandData.name}`);
    } else {
        console.log(`The moderation command ${filePath} is missing a required "data" or "execute" property`);
    }
}

// ENV VALIDATION - checks important .env values before logging in.
requireEnv('BOT_TOKEN');
validateSnowflake('CLIENT_ID');
validateSnowflake('GUILD_ID', false);

// ERROR LOGGING - prints async errors that would otherwise be hard to see.
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// ERROR LOGGING - prints unexpected crashes before the process exits.
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// READY EVENT - runs once after Discord confirms the bot is online.
client.once(Events.ClientReady, async () => {
    console.log(`Ready! Logged in as ${client.user.tag}`);

    // SLASH DEPLOY - refreshes slash commands when the bot starts.
    await deployCommands(client.commands);
    console.log('Commands deployed!');

    // PRESENCE CONFIG - reads status and activity text from .env.
    const statusType = (process.env.BOT_STATUS || 'online').toLowerCase();
    const activityType = (process.env.ACTIVITY_TYPE || 'PLAYING').toUpperCase();
    const activityName = process.env.ACTIVITY_NAME || 'Economy';

    // ACTIVITY MAP - converts readable activity names into Discord constants.
    const activityTypeMap = {
        'PLAYING': ActivityType.Playing,
        'WATCHING': ActivityType.Watching,
        'LISTENING': ActivityType.Listening,
        'STREAMING': ActivityType.Streaming,
        'COMPETING': ActivityType.Competing
    };

    // STATUS MAP - converts readable status names into Discord constants.
    const statusMap = {
        'online': PresenceUpdateStatus.Online,
        'idle': PresenceUpdateStatus.Idle,
        'dnd': PresenceUpdateStatus.DoNotDisturb,
        'invisible': PresenceUpdateStatus.Invisible
    };

    // PRESENCE UPDATE - sets the bot's online status and activity.
    client.user.setPresence({
        status: statusMap[statusType] || PresenceUpdateStatus.Online,
        activities: [{
            name: activityName,
            type: activityTypeMap[activityType] || ActivityType.Playing
        }]
    });

    console.log(`Bot Status set to: ${statusType}`);
    console.log(`Activity set to: ${activityType} ${activityName}`);
    console.log(`Listening for prefix commands: ${PREFIXES.join(', ')}`);
    console.log(`Owed coin data path: ${getDataPath()}`);
    startDropScheduler(client);
    startGiveawayScheduler(client);
    console.log(describeRestriction('User command access', ALLOWED_USER_IDS));
    console.log(describeRestriction('Role command access', ALLOWED_ROLE_IDS));
    console.log(describeRestriction('Command channels', ALLOWED_CHANNEL_IDS));

});

// PREFIX CONFIG - controls which prefix starts text commands.
const PREFIXES = ['!'];

// CSV ID CONFIG - turns comma-separated Discord IDs from .env into a clean set.
function parseIdSet(value) {
    return new Set(
        (value || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean)
    );
}

// TEMP COMMAND ACCESS - comma-separated Discord user, role, and channel IDs.
// Leave these empty to let everyone use commands in every channel again.
const ALLOWED_USER_IDS = parseIdSet(process.env.ALLOWED_USER_IDS);
const ALLOWED_ROLE_IDS = parseIdSet(process.env.ALLOWED_ROLE_IDS);
const ALLOWED_CHANNEL_IDS = parseIdSet(process.env.ALLOWED_CHANNEL_IDS);
const COINS_ALLOWED_CATEGORY_IDS = parseIdSet(process.env.COINS_ALLOWED_CATEGORY_IDS || '1212047435816378378');

// ROLE ACCESS CHECK - lets configured users through, or members with a configured role.
function canUseCommand(memberOrUser) {
    const userId = memberOrUser.user?.id || memberOrUser.id;
    const roles = memberOrUser.roles;

    if (ALLOWED_USER_IDS.size === 0 && ALLOWED_ROLE_IDS.size === 0) {
        return true;
    }

    if (ALLOWED_USER_IDS.has(userId)) {
        return true;
    }

    if (roles?.cache?.some(role => ALLOWED_ROLE_IDS.has(role.id))) {
        return true;
    }

    return Array.isArray(roles) && roles.some(roleId => ALLOWED_ROLE_IDS.has(roleId));
}

function getChannelParentId(channelId, channel) {
    return channel?.parentId || client.channels.cache.get(channelId)?.parentId || null;
}

// CHANNEL ACCESS CHECK - limits commands to configured channels when ALLOWED_CHANNEL_IDS is set.
function canUseChannel(channelId, commandName, channel) {
    if (ALLOWED_CHANNEL_IDS.size === 0 || ALLOWED_CHANNEL_IDS.has(channelId)) {
        return true;
    }

    if (commandName === 'coins' || commandName === 'clearcoins') {
        return COINS_ALLOWED_CATEGORY_IDS.has(getChannelParentId(channelId, channel));
    }

    return false;
}

// ENV DISPLAY - keeps startup logs readable for temporary restrictions.
function describeRestriction(name, values) {
    return values.size > 0
        ? `${name} restricted to ${values.size} ID(s).`
        : `${name} is open.`;
}

// ACCESS DENIED MESSAGES - shared by slash and prefix commands.
const ACCESS_DENIED_MESSAGE = 'You are not allowed to use bot commands right now.';
const CHANNEL_DENIED_MESSAGE = 'Bot commands are not enabled in this channel right now.';

// ACCESS VALIDATION - checks both temporary role/user access and channel access.
function getAccessDeniedMessage(memberOrUser, channelId, commandName, channel) {
    if (!canUseChannel(channelId, commandName, channel)) {
        return CHANNEL_DENIED_MESSAGE;
    }

    if (!canUseCommand(memberOrUser)) {
        return ACCESS_DENIED_MESSAGE;
    }

    return null;
}

client.on(Events.InteractionCreate, async interaction => {
    if (await handleGiveawayInteraction(interaction)) {
        return;
    }

    if (await handleClaimButton(interaction)) {
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    // COMMAND FINDER - gets the command file matching the slash command name.
    const command = client.commands.get(interaction.commandName);

    if (!command) {
        return;
    }

    // TEMP ACCESS CHECK - blocks slash commands outside configured users, roles, or channels.
    const accessDeniedMessage = getAccessDeniedMessage(
        interaction.member || interaction.user,
        interaction.channelId,
        interaction.commandName,
        interaction.channel,
    );

    if (accessDeniedMessage) {
        return interaction.reply({ content: accessDeniedMessage, ephemeral: true });
    }

    // COMMAND EXECUTION - runs the slash command and catches errors.
    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error while executing this command.', ephemeral: true });
            } else {
                await interaction.reply({ content: 'There was an error while executing this command.', ephemeral: true });
            }
        } catch (replyError) {
            console.error('Failed to send error message for slash command:', replyError);
        }
    }
});

// PREFIX HANDLER - runs commands from normal messages like !roll case1.
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    // PREFIX CHECK - ignores messages that do not start with an allowed prefix.
    const prefix = PREFIXES.find(currentPrefix => message.content.startsWith(currentPrefix));

    if (!prefix) return;

    // ARGUMENT PARSING - splits the command name from the rest of the message.
    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    // COMMAND FINDER - gets the command file matching the prefix command name.
    const command = client.commands.get(commandName);

    if (!command) {
        console.log(`Unknown prefix command: ${commandName}`);
        return;
    }

    // TEMP ACCESS CHECK - blocks prefix commands outside configured users, roles, or channels.
    const accessDeniedMessage = getAccessDeniedMessage(
        message.member || message.author,
        message.channelId,
        commandName,
        message.channel,
    );

    if (accessDeniedMessage) {
        return message.reply({ content: accessDeniedMessage });
    }

    // COMMAND EXECUTION - runs the prefix command and replies if it fails.
    try {
        await command.execute(message, args);
    } catch (error) {
        console.error(error);
        try {
            await message.reply({ content: 'There was an error while executing this command' });
        } catch (replyError) {
            console.error('Failed to send error message for prefix command:', replyError);
        }
    }
});

// BOT LOGIN - connects the bot to Discord.
client.login(process.env.BOT_TOKEN).catch(error => {
    console.error('Failed to log in to Discord:', error);
});
