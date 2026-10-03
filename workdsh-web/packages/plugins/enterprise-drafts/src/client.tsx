import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import { Icon } from 'workdsh-ui';
import { createDraftClient } from './rpc.js';
import { DraftPanelModel } from './model.js';
import { EnterpriseDraftPanel } from './client/Panel.js';
import { NativeSessionNavigation } from './navigation.js';

export const name = 'workdsh-enterprise-drafts-client';
export const inject = ['slots', 'layout', 'connection', 'uiWorkspace', 'sessions', 'remote', 'remote.session'];
export const panelKey = 'afos-enterprise-drafts';
function NavigationIcon(): React.ReactElement { return <Icon name="library" />; }
export function apply(ctx: Context): void {
  const lifetime = new AbortController();
  // rc.2 exports the Client face without augmenting Context.connection. Narrow
  // this owned service to its public Client interface, never its Host face.
  const connection = (ctx as Context & { readonly connection: ConnectionHandle }).connection;
  const model = new DraftPanelModel(createDraftClient(connection.rpc, lifetime.signal));
  const navigation = new NativeSessionNavigation(connection, ctx.sessions, ctx.remote, model, sessionId => {
    ctx.uiWorkspace.openSession(sessionId); ctx.layout.selectPanel(null);
  });
  ctx.effect(() => () => { lifetime.abort(); navigation.close(); model.close(); }, 'afos.enterprise-drafts.client');
  ctx.on('connection/reset', () => { navigation.connectionReset(); model.invalidate(); void model.refresh(); });
  ctx.effect(() => connection.generation.subscribe(() => {
    if (!connection.generation.getSnapshot()) model.invalidate();
  }));
  const openSession = async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    lifetime.signal.throwIfAborted();
    await navigation.open(sessionId, signal);
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelKey,
    inject: () => ({ model, openSession, toggleNavigation: () => ctx.layout.toggleSidebar() }),
  }, EnterpriseDraftPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelKey, label: '企业草稿', order: 35,
  }, NavigationIcon));
}
