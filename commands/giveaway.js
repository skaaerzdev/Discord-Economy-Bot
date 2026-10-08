const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    ModalBuilder,
    PermissionsBitField,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { getGiveaway, getGiveaways, setGiveaway, updateGiveaway } = require('../caseStore');

const pendingGiveaways = new Map();
const pendingGiveawayEdits = new Map();
const GIVEAWAY_COLOR = 0xf2c94c;
const DEFAULT_CLAIM_HOURS = 24;
const CHECK_INTERVAL_MS = 60 * 1000;
let schedulerStarted = false;

function parseDuration(value) {
    const match = String(value || '').trim().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/i);

    if (!match) {
        return null;
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = {
        s: 1000,
        sec: 1000,
        secs: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        mins: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        hrs: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
    };

    return amount > 0 ? amount * multipliers[unit] : null;
}

function parseRoleIds(value) {
    return [...new Set(
        String(value || '')
            .match(/\d{17,20}/g) || [],
    )];
}

function parseBonusRoles(value) {
    if (!value) {
        return [];
    }

    return String(value)
        .split(',')
        .map(part => {
            const roleId = (part.match(/\d{17,20}/) || [])[0];
            const entries = Number((part.match(/[:x=]\s*(\d+)/i) || [])[1] || 0);

            if (!roleId || entries <= 0) {
                return null;
            }

            return { roleId, entries };
        })
        .filter(Boolean);
}

function formatRoleList(roleIds) {
    return roleIds?.length ? roleIds.map(roleId => `<@&${roleId}>`).join(', ') : 'None';
}

function formatBonusRoles(bonusRoles) {
    return bonusRoles?.length
        ? bonusRoles.map(role => `<@&${role.roleId}> +${role.entries}`).join(', ')
        : 'None';
}

function getEntryCount(member, giveaway) {
    let entries = 1;

    for (const bonusRole of giveaway.bonusRoles || []) {
        if (member.roles.cache.has(bonusRole.roleId)) {
            entries += bonusRole.entries;
        }
    }

    return entries;
}

function getEntrantCount(giveaway) {
    return Object.keys(giveaway.entries || {}).length;
}

function buildGiveawayEmbed(giveaway) {
    const statusText = giveaway.status === 'active'
        ? `Ends <t:${Math.floor(giveaway.endAt / 1000)}:R>`
        : giveaway.status === 'claiming'
            ? `Claim by <t:${Math.floor(giveaway.claimUntil / 1000)}:R>`
            : 'Ended';

    const winnerText = giveaway.winnerIds?.length
        ? giveaway.winnerIds.map(userId => `<@${userId}>`).join(', ')
        : `${giveaway.winnersCount} winner${giveaway.winnersCount === 1 ? '' : 's'}`;

    const embed = new EmbedBuilder()
        .setTitle(giveaway.prize)
        .setColor(GIVEAWAY_COLOR)
        .setDescription([
            `**Winners:** ${winnerText}`,
            `**Host:** <@${giveaway.hostId}>`,
            `**Entries:** ${getEntrantCount(giveaway)}`,
            `**Required Roles:** ${formatRoleList(giveaway.requiredRoleIds)}`,
            `**Extra Entries:** ${formatBonusRoles(giveaway.bonusRoles)}`,
            `**Status:** ${statusText}`,
        ].join('\n'))
        .setTimestamp(giveaway.endAt);

    if (giveaway.imageUrl) {
        embed.setImage(giveaway.imageUrl);
    }

    if (giveaway.thumbnailUrl) {
        embed.setThumbnail(giveaway.thumbnailUrl);
    }

    if (giveaway.status === 'claiming') {
        embed.setFooter({ text: 'Winners must press Claim before the claim timer expires.' });
    }

    return embed;
}

function buildJoinRow(giveaway) {
    const button = new ButtonBuilder()
        .setCustomId(`giveaway:join:${giveaway.messageId}`)
        .setLabel(`Join Giveaway (${getEntrantCount(giveaway)})`)
        .setStyle(ButtonStyle.Success);

    return new ActionRowBuilder().addComponents(button);
}

function buildClaimRow(giveaway) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`giveaway:claim:${giveaway.messageId}`)
            .setLabel('Claim Prize')
            .setStyle(ButtonStyle.Primary),
    );
}

function buildPreviewRows(pendingId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`giveaway:preview:edit:${pendingId}`)
                .setLabel('Edit')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`giveaway:preview:cancel:${pendingId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`giveaway:preview:send:${pendingId}`)
                .setLabel('Send')
                .setStyle(ButtonStyle.Success),
        ),
    ];
}

function buildEditPreviewRows(pendingId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`giveaway:editpreview:cancel:${pendingId}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`giveaway:editpreview:apply:${pendingId}`)
                .setLabel('Apply Changes')
                .setStyle(ButtonStyle.Success),
        ),
    ];
}

function buildPreviewEmbed(giveaway) {
    return buildGiveawayEmbed({
        ...giveaway,
        messageId: 'preview',
        entries: {},
        status: 'active',
        endAt: Date.now() + giveaway.durationMs,
    }).setFooter({ text: 'Preview only. Use the buttons below to edit, cancel, or send.' });
}

function buildEditPreviewEmbed(giveaway) {
    return buildGiveawayEmbed(giveaway)
        .setFooter({ text: 'Preview of the edited giveaway. Apply changes or cancel below.' });
}

function pickWinners(giveaway, excludedUserIds = []) {
    const excluded = new Set(excludedUserIds);
    const pool = [];

    for (const [userId, entries] of Object.entries(giveaway.entries || {})) {
        if (excluded.has(userId)) {
            continue;
        }

        for (let index = 0; index < Math.max(1, entries); index += 1) {
            pool.push(userId);
        }
    }

    const winners = [];

    while (pool.length > 0 && winners.length < giveaway.winnersCount) {
        const pickedIndex = Math.floor(Math.random() * pool.length);
        const pickedUserId = pool[pickedIndex];
        winners.push(pickedUserId);

        for (let index = pool.length - 1; index >= 0; index -= 1) {
            if (pool[index] === pickedUserId) {
                pool.splice(index, 1);
            }
        }
    }

    return winners;
}

async function fetchGiveawayMessage(client, giveaway) {
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);

    if (!channel?.isTextBased?.()) {
        return null;
    }

    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    return message || null;
}

async function assignWinnerRole(guild, winnerIds, roleId) {
    if (!roleId) {
        return;
    }

    const botMember = guild.members.me || await guild.members.fetchMe();

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return;
    }

    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);

    if (!role || role.managed || role.position >= botMember.roles.highest.position) {
        return;
    }

    for (const winnerId of winnerIds) {
        const member = await guild.members.fetch(winnerId).catch(() => null);

        if (member) {
            await member.roles.add(role).catch(() => null);
        }
    }
}

async function finishGiveaway(client, giveaway) {
    const winnerIds = pickWinners(giveaway);
    const claimUntil = Date.now() + giveaway.claimHours * 60 * 60 * 1000;

    const updated = updateGiveaway(giveaway.messageId, current => ({
        ...current,
        status: winnerIds.length ? 'claiming' : 'ended',
        winnerIds,
        claimedWinnerIds: [],
        claimUntil,
    }));

    const message = await fetchGiveawayMessage(client, updated);

    if (!message) {
        return;
    }

    const components = winnerIds.length ? [buildClaimRow(updated)] : [];
    await message.edit({
        content: updated.content || '',
        embeds: [buildGiveawayEmbed(updated)],
        components,
    }).catch(() => null);

    if (winnerIds.length) {
        await assignWinnerRole(message.guild, winnerIds, updated.winnerRoleId);
        await message.channel.send({
            content: `${winnerIds.map(userId => `<@${userId}>`).join(', ')} won **${updated.prize}**! Press the claim button on the giveaway message before <t:${Math.floor(claimUntil / 1000)}:R>.`,
            allowedMentions: { users: winnerIds },
        }).catch(() => null);
    } else {
        await message.channel.send(`No valid entries for **${updated.prize}**.`).catch(() => null);
    }
}

async function rerollExpiredGiveaway(client, giveaway) {
    const unclaimed = (giveaway.winnerIds || []).filter(userId => !(giveaway.claimedWinnerIds || []).includes(userId));

    if (unclaimed.length === 0) {
        updateGiveaway(giveaway.messageId, current => ({ ...current, status: 'ended' }));
        return;
    }

    const previousWinners = giveaway.winnerIds || [];
    const newWinners = pickWinners({ ...giveaway, winnersCount: unclaimed.length }, previousWinners);
    const finalWinners = [
        ...(giveaway.claimedWinnerIds || []),
        ...newWinners,
    ];
    const claimUntil = Date.now() + giveaway.claimHours * 60 * 60 * 1000;
    const status = newWinners.length ? 'claiming' : 'ended';

    const updated = updateGiveaway(giveaway.messageId, current => ({
        ...current,
        status,
        winnerIds: finalWinners,
        claimedWinnerIds: giveaway.claimedWinnerIds || [],
        claimUntil,
    }));

    const message = await fetchGiveawayMessage(client, updated);

    if (!message) {
        return;
    }

    await message.edit({
        content: updated.content || '',
        embeds: [buildGiveawayEmbed(updated)],
        components: status === 'claiming' ? [buildClaimRow(updated)] : [],
    }).catch(() => null);

    if (newWinners.length) {
        await assignWinnerRole(message.guild, newWinners, updated.winnerRoleId);
        await message.channel.send({
            content: `${newWinners.map(userId => `<@${userId}>`).join(', ')} won the reroll for **${updated.prize}**! Claim before <t:${Math.floor(claimUntil / 1000)}:R>.`,
            allowedMentions: { users: newWinners },
        }).catch(() => null);
    } else {
        await message.channel.send(`No replacement winners were available for **${updated.prize}**.`).catch(() => null);
    }
}

async function rerollGiveaway(client, giveaway, rerollCount = null) {
    const previousWinners = giveaway.winnerIds || [];
    const targetCount = Math.max(1, rerollCount || giveaway.winnersCount || 1);
    const newWinners = pickWinners({ ...giveaway, winnersCount: targetCount }, previousWinners);
    const claimUntil = Date.now() + giveaway.claimHours * 60 * 60 * 1000;
    const status = newWinners.length ? 'claiming' : 'ended';

    const updated = updateGiveaway(giveaway.messageId, current => ({
        ...current,
        status,
        winnerIds: newWinners,
        claimedWinnerIds: [],
        claimUntil,
    }));

    const message = await fetchGiveawayMessage(client, updated);

    if (!message) {
        return { ok: false, reason: 'I found the giveaway data, but I could not fetch the Discord message.' };
    }

    await message.edit({
        content: updated.content || '',
        embeds: [buildGiveawayEmbed(updated)],
        components: status === 'claiming' ? [buildClaimRow(updated)] : [],
    });

    if (newWinners.length) {
        await assignWinnerRole(message.guild, newWinners, updated.winnerRoleId);
        await message.channel.send({
            content: `${newWinners.map(userId => `<@${userId}>`).join(', ')} won the reroll for **${updated.prize}**! Claim before <t:${Math.floor(claimUntil / 1000)}:R>.`,
            allowedMentions: { users: newWinners },
        });
    } else {
        await message.channel.send(`No replacement winners were available for **${updated.prize}**.`);
    }

    return { ok: true, winners: newWinners, message };
}

async function runGiveawayChecks(client) {
    const now = Date.now();
    const giveaways = getGiveaways();

    for (const giveaway of Object.values(giveaways)) {
        if (giveaway.status === 'active' && now >= giveaway.endAt) {
            await finishGiveaway(client, giveaway);
        }

        if (giveaway.status === 'claiming' && now >= giveaway.claimUntil) {
            await rerollExpiredGiveaway(client, giveaway);
        }
    }
}

function startGiveawayScheduler(client) {
    if (schedulerStarted) {
        return;
    }

    schedulerStarted = true;
    setInterval(() => {
        runGiveawayChecks(client).catch(error => {
            console.error('Giveaway scheduler error:', error);
        });
    }, CHECK_INTERVAL_MS);
}

function createPendingGiveaway(interaction) {
    const durationMs = parseDuration(interaction.options.getString('duration'));

    if (!durationMs) {
        return { error: 'Use a duration like `30m`, `6h`, or `2d`.' };
    }

    const channel = interaction.options.getChannel('channel');

    if (!channel?.isTextBased?.()) {
        return { error: 'Pick a text channel for the giveaway.' };
    }

    const claimHours = interaction.options.getInteger('claim_hours') || DEFAULT_CLAIM_HOURS;
    const imageAttachment = interaction.options.getAttachment('image_attachment');
    const thumbnailAttachment = interaction.options.getAttachment('thumbnail_attachment');

    return {
        giveaway: {
            guildId: interaction.guildId,
            channelId: channel.id,
            creatorId: interaction.user.id,
            hostId: (interaction.options.getUser('host') || interaction.user).id,
            prize: interaction.options.getString('prize'),
            winnersCount: interaction.options.getInteger('winners'),
            durationMs,
            claimHours,
            pingRoleId: interaction.options.getRole('ping_role')?.id || null,
            winnerRoleId: interaction.options.getRole('winner_role')?.id || null,
            requiredRoleIds: parseRoleIds(interaction.options.getString('required_roles')),
            bonusRoles: parseBonusRoles(interaction.options.getString('extra_entries')),
            content: interaction.options.getString('message') || '',
            imageUrl: imageAttachment?.url || interaction.options.getString('image') || null,
            thumbnailUrl: thumbnailAttachment?.url || interaction.options.getString('thumbnail') || null,
        },
    };
}

async function executeCreate(interaction) {
    const pending = createPendingGiveaway(interaction);

    if (pending.error) {
        return interaction.reply({ content: pending.error, ephemeral: true });
    }

    const pendingId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    pendingGiveaways.set(pendingId, pending.giveaway);

    return interaction.reply({
        content: 'Giveaway preview:',
        embeds: [buildPreviewEmbed(pending.giveaway)],
        components: buildPreviewRows(pendingId),
        ephemeral: true,
    });
}

function mergeEditedGiveaway(interaction, giveaway) {
    const durationInput = interaction.options.getString('duration');
    const durationMs = durationInput ? parseDuration(durationInput) : null;

    if (durationInput && !durationMs) {
        return { error: 'Use a duration like `30m`, `6h`, or `2d`.' };
    }

    const channel = interaction.options.getChannel('channel');
    const host = interaction.options.getUser('host');
    const pingRole = interaction.options.getRole('ping_role');
    const winnerRole = interaction.options.getRole('winner_role');
    const requiredRoles = interaction.options.getString('required_roles');
    const extraEntries = interaction.options.getString('extra_entries');
    const imageAttachment = interaction.options.getAttachment('image_attachment');
    const thumbnailAttachment = interaction.options.getAttachment('thumbnail_attachment');
    const claimHours = interaction.options.getInteger('claim_hours');
    const winnersCount = interaction.options.getInteger('winners');
    const now = Date.now();

    return {
        giveaway: {
            ...giveaway,
            channelId: channel?.id || giveaway.channelId,
            hostId: host?.id || giveaway.hostId,
            prize: interaction.options.getString('prize') ?? giveaway.prize,
            winnersCount: winnersCount ?? giveaway.winnersCount,
            durationMs: durationMs ?? giveaway.durationMs,
            claimHours: claimHours ?? giveaway.claimHours,
            pingRoleId: pingRole?.id || giveaway.pingRoleId,
            winnerRoleId: winnerRole?.id || giveaway.winnerRoleId,
            requiredRoleIds: requiredRoles === null ? giveaway.requiredRoleIds : parseRoleIds(requiredRoles),
            bonusRoles: extraEntries === null ? giveaway.bonusRoles : parseBonusRoles(extraEntries),
            content: interaction.options.getString('message') ?? giveaway.content,
            imageUrl: imageAttachment?.url || interaction.options.getString('image') || giveaway.imageUrl,
            thumbnailUrl: thumbnailAttachment?.url || interaction.options.getString('thumbnail') || giveaway.thumbnailUrl,
            endAt: durationMs && giveaway.status === 'active' ? now + durationMs : giveaway.endAt,
        },
    };
}

async function executeEdit(interaction) {
    const messageId = interaction.options.getString('message_id');
    const giveaway = getGiveaway(messageId);

    if (!giveaway) {
        return interaction.reply({ content: 'I could not find a saved giveaway with that message ID.', ephemeral: true });
    }

    const edited = mergeEditedGiveaway(interaction, giveaway);

    if (edited.error) {
        return interaction.reply({ content: edited.error, ephemeral: true });
    }

    const pendingId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    pendingGiveawayEdits.set(pendingId, {
        originalMessageId: messageId,
        editorId: interaction.user.id,
        giveaway: edited.giveaway,
    });

    return interaction.reply({
        content: 'Giveaway edit preview:',
        embeds: [buildEditPreviewEmbed(edited.giveaway)],
        components: buildEditPreviewRows(pendingId),
        ephemeral: true,
    });
}

async function executeReroll(interaction) {
    const messageId = interaction.options.getString('message_id');
    const giveaway = getGiveaway(messageId);

    if (!giveaway) {
        return interaction.reply({ content: 'I could not find a saved giveaway with that message ID.', ephemeral: true });
    }

    const rerollCount = interaction.options.getInteger('winners') || giveaway.winnersCount;
    const result = await rerollGiveaway(interaction.client, giveaway, rerollCount);

    if (!result.ok) {
        return interaction.reply({ content: result.reason, ephemeral: true });
    }

    return interaction.reply({
        content: result.winners.length
            ? `Rerolled **${giveaway.prize}**. New winner${result.winners.length === 1 ? '' : 's'}: ${result.winners.map(userId => `<@${userId}>`).join(', ')}`
            : `Rerolled **${giveaway.prize}**, but there were no eligible replacement winners.`,
        ephemeral: true,
        allowedMentions: { users: [] },
    });
}

async function handlePreviewButton(interaction, parts) {
    const action = parts[2];
    const pendingId = parts[3];
    const giveaway = pendingGiveaways.get(pendingId);

    if (!giveaway) {
        await interaction.reply({ content: 'That giveaway preview expired. Run `/giveaway create` again.', ephemeral: true });
        return true;
    }

    if (giveaway.creatorId !== interaction.user.id) {
        await interaction.reply({ content: 'Only the command user can use this preview.', ephemeral: true });
        return true;
    }

    if (action === 'cancel') {
        pendingGiveaways.delete(pendingId);
        await interaction.update({ content: 'Giveaway cancelled.', embeds: [], components: [] });
        return true;
    }

    if (action === 'edit') {
        const modal = new ModalBuilder()
            .setCustomId(`giveaway:preview:modal:${pendingId}`)
            .setTitle('Edit Giveaway Preview')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('prize')
                        .setLabel('Prize')
                        .setStyle(TextInputStyle.Short)
                        .setValue(giveaway.prize)
                        .setRequired(true),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('message')
                        .setLabel('Message content')
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(giveaway.content || '')
                        .setRequired(false),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image')
                        .setLabel('Image URL')
                        .setStyle(TextInputStyle.Short)
                        .setValue(giveaway.imageUrl || '')
                        .setRequired(false),
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('thumbnail')
                        .setLabel('Thumbnail URL')
                        .setStyle(TextInputStyle.Short)
                        .setValue(giveaway.thumbnailUrl || '')
                        .setRequired(false),
                ),
            );

        await interaction.showModal(modal);
        return true;
    }

    if (action === 'send') {
        const channel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);

        if (!channel?.isTextBased?.()) {
            await interaction.reply({ content: 'I could not fetch the selected giveaway channel.', ephemeral: true });
            return true;
        }

        const liveGiveaway = {
            ...giveaway,
            messageId: 'pending',
            status: 'active',
            entries: {},
            winnerIds: [],
            claimedWinnerIds: [],
            endAt: Date.now() + giveaway.durationMs,
        };
        const contentParts = [];

        if (liveGiveaway.pingRoleId) {
            contentParts.push(`<@&${liveGiveaway.pingRoleId}>`);
        }

        if (liveGiveaway.content) {
            contentParts.push(liveGiveaway.content);
        }

        const message = await channel.send({
            content: contentParts.join('\n'),
            embeds: [buildGiveawayEmbed(liveGiveaway)],
            components: [buildJoinRow(liveGiveaway)],
            allowedMentions: {
                roles: liveGiveaway.pingRoleId ? [liveGiveaway.pingRoleId] : [],
            },
        });

        liveGiveaway.messageId = message.id;
        setGiveaway(message.id, liveGiveaway);
        pendingGiveaways.delete(pendingId);

        await message.edit({
            embeds: [buildGiveawayEmbed(liveGiveaway)],
            components: [buildJoinRow(liveGiveaway)],
        });
        await interaction.update({ content: `Giveaway sent in ${channel}. Message ID: \`${message.id}\``, embeds: [], components: [] });
        return true;
    }

    return false;
}

async function handlePreviewModal(interaction, parts) {
    const pendingId = parts[3];
    const giveaway = pendingGiveaways.get(pendingId);

    if (!giveaway) {
        await interaction.reply({ content: 'That giveaway preview expired. Run `/giveaway create` again.', ephemeral: true });
        return true;
    }

    if (giveaway.creatorId !== interaction.user.id) {
        await interaction.reply({ content: 'Only the command user can edit this preview.', ephemeral: true });
        return true;
    }

    const edited = {
        ...giveaway,
        prize: interaction.fields.getTextInputValue('prize'),
        content: interaction.fields.getTextInputValue('message'),
        imageUrl: interaction.fields.getTextInputValue('image') || null,
        thumbnailUrl: interaction.fields.getTextInputValue('thumbnail') || null,
    };

    pendingGiveaways.set(pendingId, edited);
    await interaction.update({
        content: 'Giveaway preview:',
        embeds: [buildPreviewEmbed(edited)],
        components: buildPreviewRows(pendingId),
    });
    return true;
}

async function applyGiveawayEdit(interaction, pendingEdit) {
    const { originalMessageId, giveaway } = pendingEdit;
    const oldGiveaway = getGiveaway(originalMessageId);

    if (!oldGiveaway) {
        await interaction.reply({ content: 'That giveaway no longer exists.', ephemeral: true });
        return true;
    }

    const oldMessage = await fetchGiveawayMessage(interaction.client, oldGiveaway);

    if (giveaway.channelId !== oldGiveaway.channelId) {
        const newChannel = await interaction.client.channels.fetch(giveaway.channelId).catch(() => null);

        if (!newChannel?.isTextBased?.()) {
            await interaction.reply({ content: 'I could not fetch the new giveaway channel.', ephemeral: true });
            return true;
        }

        const newGiveaway = { ...giveaway, messageId: 'pending' };
        const sentMessage = await newChannel.send({
            content: newGiveaway.content || '',
            embeds: [buildGiveawayEmbed(newGiveaway)],
            components: newGiveaway.status === 'active'
                ? [buildJoinRow(newGiveaway)]
                : newGiveaway.status === 'claiming'
                    ? [buildClaimRow(newGiveaway)]
                    : [],
            allowedMentions: { roles: [] },
        });

        newGiveaway.messageId = sentMessage.id;
        setGiveaway(sentMessage.id, newGiveaway);
        updateGiveaway(originalMessageId, () => null);
        await oldMessage?.delete().catch(() => null);
        await sentMessage.edit({
            embeds: [buildGiveawayEmbed(newGiveaway)],
            components: newGiveaway.status === 'active'
                ? [buildJoinRow(newGiveaway)]
                : newGiveaway.status === 'claiming'
                    ? [buildClaimRow(newGiveaway)]
                    : [],
        });

        await interaction.update({ content: `Giveaway moved and updated in ${newChannel}. New message ID: \`${sentMessage.id}\``, embeds: [], components: [] });
        return true;
    }

    if (!oldMessage) {
        await interaction.reply({ content: 'I found the giveaway data, but I could not fetch the Discord message.', ephemeral: true });
        return true;
    }

    setGiveaway(originalMessageId, giveaway);
    await oldMessage.edit({
        content: giveaway.content || '',
        embeds: [buildGiveawayEmbed(giveaway)],
        components: giveaway.status === 'active'
            ? [buildJoinRow(giveaway)]
            : giveaway.status === 'claiming'
                ? [buildClaimRow(giveaway)]
                : [],
    });

    await interaction.update({ content: 'Giveaway changes applied.', embeds: [], components: [] });
    return true;
}

async function handleEditPreviewButton(interaction, parts) {
    const action = parts[2];
    const pendingId = parts[3];
    const pendingEdit = pendingGiveawayEdits.get(pendingId);

    if (!pendingEdit) {
        await interaction.reply({ content: 'That edit preview expired. Run `/giveaway edit` again.', ephemeral: true });
        return true;
    }

    if (pendingEdit.editorId !== interaction.user.id) {
        await interaction.reply({ content: 'Only the command user can use this edit preview.', ephemeral: true });
        return true;
    }

    if (action === 'cancel') {
        pendingGiveawayEdits.delete(pendingId);
        await interaction.update({ content: 'Giveaway edit cancelled.', embeds: [], components: [] });
        return true;
    }

    if (action === 'apply') {
        pendingGiveawayEdits.delete(pendingId);
        return applyGiveawayEdit(interaction, pendingEdit);
    }

    return false;
}

async function handleJoinButton(interaction, messageId) {
    const giveaway = getGiveaway(messageId);

    if (!giveaway || giveaway.status !== 'active') {
        await interaction.reply({ content: 'This giveaway is not open anymore.', ephemeral: true });
        return true;
    }

    const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    if (!member) {
        await interaction.reply({ content: 'I could not check your server roles.', ephemeral: true });
        return true;
    }

    const missingRoles = (giveaway.requiredRoleIds || []).filter(roleId => !member.roles.cache.has(roleId));

    if (missingRoles.length) {
        await interaction.reply({ content: `You need ${formatRoleList(missingRoles)} to join this giveaway.`, ephemeral: true });
        return true;
    }

    const entries = getEntryCount(member, giveaway);
    const updated = updateGiveaway(messageId, current => ({
        ...current,
        entries: {
            ...(current.entries || {}),
            [interaction.user.id]: entries,
        },
    }));

    await interaction.update({
        content: interaction.message.content,
        embeds: [buildGiveawayEmbed(updated)],
        components: [buildJoinRow(updated)],
    });
    await interaction.followUp({ content: `You joined with **${entries}** entr${entries === 1 ? 'y' : 'ies'}.`, ephemeral: true });
    return true;
}

async function handleClaimButton(interaction, messageId) {
    const giveaway = getGiveaway(messageId);

    if (!giveaway || giveaway.status !== 'claiming') {
        await interaction.reply({ content: 'This giveaway is not waiting for claims.', ephemeral: true });
        return true;
    }

    if (!(giveaway.winnerIds || []).includes(interaction.user.id)) {
        await interaction.reply({ content: 'Only selected winners can claim this prize.', ephemeral: true });
        return true;
    }

    if ((giveaway.claimedWinnerIds || []).includes(interaction.user.id)) {
        await interaction.reply({ content: 'You already claimed this prize.', ephemeral: true });
        return true;
    }

    const claimedWinnerIds = [...(giveaway.claimedWinnerIds || []), interaction.user.id];
    const allClaimed = claimedWinnerIds.length >= (giveaway.winnerIds || []).length;
    const updated = updateGiveaway(messageId, current => ({
        ...current,
        claimedWinnerIds,
        status: allClaimed ? 'ended' : current.status,
    }));

    await interaction.update({
        content: interaction.message.content,
        embeds: [buildGiveawayEmbed(updated)],
        components: allClaimed ? [] : [buildClaimRow(updated)],
    });
    await interaction.followUp({ content: 'Prize claimed. A staff member can now fulfil it.', ephemeral: true });
    return true;
}

async function handleGiveawayInteraction(interaction) {
    if (!interaction.isButton?.() && !interaction.isModalSubmit?.()) {
        return false;
    }

    if (!interaction.customId?.startsWith('giveaway:')) {
        return false;
    }

    const parts = interaction.customId.split(':');

    if (interaction.isModalSubmit() && parts[1] === 'preview' && parts[2] === 'modal') {
        return handlePreviewModal(interaction, parts);
    }

    if (parts[1] === 'preview') {
        return handlePreviewButton(interaction, parts);
    }

    if (parts[1] === 'editpreview') {
        return handleEditPreviewButton(interaction, parts);
    }

    if (parts[1] === 'join') {
        return handleJoinButton(interaction, parts[2]);
    }

    if (parts[1] === 'claim') {
        return handleClaimButton(interaction, parts[2]);
    }

    return false;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Create and manage giveaways')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a giveaway with a preview before it sends')
                .addStringOption(option => option.setName('duration').setDescription('How long the giveaway lasts, like 30m, 6h, or 2d').setRequired(true))
                .addIntegerOption(option => option.setName('winners').setDescription('Amount of winners').setRequired(true).setMinValue(1).setMaxValue(25))
                .addStringOption(option => option.setName('prize').setDescription('Prize shown as the embed title').setRequired(true))
                .addChannelOption(option => option.setName('channel').setDescription('Channel where the giveaway should be sent').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addUserOption(option => option.setName('host').setDescription('Giveaway host').setRequired(false))
                .addRoleOption(option => option.setName('ping_role').setDescription('Role to ping when the giveaway is sent').setRequired(false))
                .addRoleOption(option => option.setName('winner_role').setDescription('Role to give winners').setRequired(false))
                .addIntegerOption(option => option.setName('claim_hours').setDescription('Hours winners have to claim before rerolling').setRequired(false).setMinValue(1).setMaxValue(168))
                .addStringOption(option => option.setName('required_roles').setDescription('Role mentions or IDs required to join').setRequired(false))
                .addStringOption(option => option.setName('extra_entries').setDescription('Bonus roles, example: @VIP:2, @Booster:3').setRequired(false))
                .addStringOption(option => option.setName('message').setDescription('Message content above the embed').setRequired(false))
                .addStringOption(option => option.setName('image').setDescription('Embed image URL').setRequired(false))
                .addStringOption(option => option.setName('thumbnail').setDescription('Embed thumbnail URL').setRequired(false))
                .addAttachmentOption(option => option.setName('image_attachment').setDescription('Upload an embed image').setRequired(false))
                .addAttachmentOption(option => option.setName('thumbnail_attachment').setDescription('Upload an embed thumbnail').setRequired(false)),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('edit')
                .setDescription('Preview and edit a giveaway by message ID')
                .addStringOption(option => option.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
                .addStringOption(option => option.setName('duration').setDescription('Reset the remaining duration, like 30m, 6h, or 2d').setRequired(false))
                .addIntegerOption(option => option.setName('winners').setDescription('Amount of winners').setRequired(false).setMinValue(1).setMaxValue(25))
                .addStringOption(option => option.setName('prize').setDescription('Prize shown as the embed title').setRequired(false))
                .addChannelOption(option => option.setName('channel').setDescription('Move the giveaway to this channel').setRequired(false).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addUserOption(option => option.setName('host').setDescription('Giveaway host').setRequired(false))
                .addRoleOption(option => option.setName('ping_role').setDescription('Role to ping for future moved giveaway messages').setRequired(false))
                .addRoleOption(option => option.setName('winner_role').setDescription('Role to give winners').setRequired(false))
                .addIntegerOption(option => option.setName('claim_hours').setDescription('Hours winners have to claim before rerolling').setRequired(false).setMinValue(1).setMaxValue(168))
                .addStringOption(option => option.setName('required_roles').setDescription('Role mentions or IDs required to join').setRequired(false))
                .addStringOption(option => option.setName('extra_entries').setDescription('Bonus roles, example: @VIP:2, @Booster:3').setRequired(false))
                .addStringOption(option => option.setName('message').setDescription('New message content above the embed').setRequired(false))
                .addStringOption(option => option.setName('image').setDescription('New embed image URL').setRequired(false))
                .addStringOption(option => option.setName('thumbnail').setDescription('New embed thumbnail URL').setRequired(false))
                .addAttachmentOption(option => option.setName('image_attachment').setDescription('Upload a new embed image').setRequired(false))
                .addAttachmentOption(option => option.setName('thumbnail_attachment').setDescription('Upload a new embed thumbnail').setRequired(false)),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reroll')
                .setDescription('Reroll one giveaway by message ID')
                .addStringOption(option => option.setName('message_id').setDescription('Giveaway message ID').setRequired(true))
                .addIntegerOption(option => option.setName('winners').setDescription('Optional amount of winners to reroll').setRequired(false).setMinValue(1).setMaxValue(25)),
        ),

    async execute(interaction) {
        if (!interaction.isChatInputCommand?.()) {
            return interaction.reply('Giveaways use slash commands. Try `/giveaway create`, `/giveaway edit`, or `/giveaway reroll`.');
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'create') {
            return executeCreate(interaction);
        }

        if (subcommand === 'edit') {
            return executeEdit(interaction);
        }

        if (subcommand === 'reroll') {
            return executeReroll(interaction);
        }

        return interaction.reply({ content: 'Unknown giveaway subcommand.', ephemeral: true });
    },
    handleGiveawayInteraction,
    startGiveawayScheduler,
};
