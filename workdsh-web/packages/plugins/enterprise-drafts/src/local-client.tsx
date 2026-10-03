import * as React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { Icon } from 'workdsh-ui';
import { createLocalDraftClient, type LocalDraftCapability } from './local-rpc.js';
import { DraftPanelModel } from './model.js';
import { EnterpriseDraftPanel } from './client/Panel.js';

export { createLocalDraftClient } from './local-rpc.js';
export type { LocalDraftCapability, LocalDraftClient, LocalDraftState } from './local-rpc.js';
declare global { interface Window { readonly afosLocalDrafts?: LocalDraftCapability; } }

export const name = 'workdsh-enterprise-drafts-local-client';
export const inject = ['slots', 'layout'];
export const panelKey = 'afos-enterprise-drafts';
function NavigationIcon(): React.ReactElement { return <Icon name="library" />; }

/** Alternative Client face. The owning Profile must choose only one drafts face. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController();
  const client = createLocalDraftClient(window.afosLocalDrafts, lifetime.signal);
  const model = new DraftPanelModel(client);
  ctx.effect(() => {
    const unsubscribe = client.subscribe(() => { model.invalidate(); void model.refresh(); });
    return () => { lifetime.abort(); unsubscribe(); client.close(); model.close(); };
  }, 'afos.enterprise-drafts.local-client');
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({ name: 'main', key: panelKey,
      inject: () => ({ model, localOnly: true, toggleNavigation: () => ctx.layout.toggleSidebar() }),
    }, EnterpriseDraftPanel);
    // The public layout face validates this key against the registered main slot.
    ctx.layout.selectPanel(panelKey as MainPanelId);
    return dispose;
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelKey, label: '本地草稿', order: 35,
  }, NavigationIcon));
}
