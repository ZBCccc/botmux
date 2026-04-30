/**
 * Unit tests for groups-store wrappers (Lark im/v1 chat APIs).
 *
 * Run:  pnpm vitest run test/groups-store.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// chat.create is configurable per test via this stub so we can test both the
// happy path and error responses.
const chatCreateStub = vi.fn();

// Mock bot-registry's getBotClient — that's where groups-store imports from.
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'c1',
                  name: 'one',
                  description: 'first chat',
                  chat_mode: 'group',
                  owner_id: 'ou_owner',
                },
              ],
              has_more: false,
            },
          }),
          create: chatCreateStub,
        },
        chatMembers: {
          isInChat: vi.fn().mockResolvedValue({ code: 0, data: { is_in_chat: true } }),
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { invalid_id_list: ['cli_X'] },
          }),
        },
      },
    },
  })),
}));

import { listChats, isInChat, addBotToChat, createChat } from '../src/services/groups-store.js';

describe('groups-store wrappers', () => {
  beforeEach(() => { chatCreateStub.mockClear(); });

  it('listChats returns ChatBrief array', async () => {
    const out = await listChats('appA');
    expect(out).toHaveLength(1);
    expect(out[0].chatId).toBe('c1');
    expect(out[0].name).toBe('one');
    expect(out[0].description).toBe('first chat');
    expect(out[0].chatMode).toBe('group');
    expect(out[0].ownerId).toBe('ou_owner');
  });

  it('isInChat returns boolean', async () => {
    expect(await isInChat('appA', 'c1')).toBe(true);
  });

  it('addBotToChat marks invalid_id_list as failed and rest as ok', async () => {
    const r = await addBotToChat('appA', 'c1', ['cli_Y', 'cli_X']);
    expect(r.find(x => x.id === 'cli_Y')!.ok).toBe(true);
    expect(r.find(x => x.id === 'cli_X')!.ok).toBe(false);
    expect(r.find(x => x.id === 'cli_X')!.error).toBe('invalid_id');
  });

  it('addBotToChat with empty list returns empty', async () => {
    expect(await addBotToChat('appA', 'c1', [])).toEqual([]);
  });

  it('createChat returns chatId and forwards bot list (excluding creator)', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_new123', invalid_bot_id_list: [] },
    });
    const r = await createChat('cli_creator', { name: 'team', botIds: ['cli_creator', 'cli_other'] });
    expect(r.chatId).toBe('oc_new123');
    expect(r.invalidBotIds).toEqual([]);
    // Verify bot_id_list passed only the non-creator ids.
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.name).toBe('team');
    expect(callArgs.data.bot_id_list).toEqual(['cli_other']);
  });

  it('createChat omits bot_id_list when only creator is in the bot list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_solo' },
    });
    await createChat('cli_creator', { botIds: ['cli_creator'] });
    const callArgs = chatCreateStub.mock.calls[0][0];
    expect(callArgs.data.bot_id_list).toBeUndefined();
    expect(callArgs.data.name).toBeUndefined();
  });

  it('createChat throws on non-zero Lark response', async () => {
    chatCreateStub.mockResolvedValueOnce({ code: 1234, msg: 'permission denied' });
    await expect(createChat('cli_creator', { botIds: ['cli_x'] })).rejects.toThrow(/permission denied/);
  });

  it('createChat surfaces invalid_bot_id_list', async () => {
    chatCreateStub.mockResolvedValueOnce({
      code: 0,
      data: { chat_id: 'oc_partial', invalid_bot_id_list: ['cli_bad'] },
    });
    const r = await createChat('cli_creator', { botIds: ['cli_creator', 'cli_good', 'cli_bad'] });
    expect(r.invalidBotIds).toEqual(['cli_bad']);
  });
});
