/**
 * The disposable inbox is a wallet of addresses.
 *
 * "New address" used to throw the current one away; now it holds several at
 * once, like a coin wallet holds addresses, and every one reads into the same
 * inbox. These guard the shape of that: the two things that work are promoted
 * to toolbar buttons, the dead folders stay honestly inert, nothing pretends
 * the read-only inbox can send, and the client actually polls every held
 * address rather than just the active one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../public/email.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/mail-page.js', import.meta.url), 'utf8');

describe('the email toolbar', () => {
  it('promotes Inbox and Check a message to buttons next to New address', () => {
    expect(html).toMatch(/<button[^>]*class="olbtn"[^>]*data-view="inbox"/);
    expect(html).toMatch(/<button[^>]*class="olbtn"[^>]*data-view="check"/);
    // They sit in the toolbar, near New address.
    const bar = html.slice(html.indexOf('class="ol-bar"'), html.indexOf('</div>', html.indexOf('class="ol-bar"')));
    expect(bar).toContain('id="new"');
    expect(bar).toContain('data-view="inbox"');
    expect(bar).toContain('data-view="check"');
  });

  it('does not pretend a receive-only inbox can send', () => {
    // The button and menu item both said "Send and receive" / "Send/Recv" over
    // what is only ever a receive. It is an honest "Check now" now.
    expect(html).not.toMatch(/Send and receive|Send\/Recv/);
    expect(html).toContain('Check now');
    expect(html).toContain('Check for mail now');
  });
});

describe('the folder rail', () => {
  it('keeps Outbox, Sent, Deleted and Drafts as inert chrome, not live folders', () => {
    for (const folder of ['Outbox', 'Sent Items', 'Deleted Items', 'Drafts']) {
      const at = html.indexOf(folder);
      expect(at, `${folder} is missing from the rail`).toBeGreaterThan(-1);
      // The <li> carrying it is marked is-inert and has no data-view.
      const liStart = html.lastIndexOf('<li', at);
      const li = html.slice(liStart, at);
      expect(li, `${folder} became a live folder`).toContain('is-inert');
      expect(li, `${folder} became navigable`).not.toContain('data-view');
    }
  });

  it('leaves only Inbox and Check a message as real destinations', () => {
    expect(html).toMatch(/data-view="inbox"[\s\S]*?Inbox/);
    expect(html).toMatch(/data-view="check"/);
  });
});

describe('the address wallet', () => {
  it('has an active address that copies, a list of held addresses, and per-row copy', () => {
    expect(html).toContain('id="address-copy"');
    expect(html).toContain('id="ol-addr-list"');
    expect(html).toContain('id="burn-all"');
  });

  it('holds several addresses and caps them', () => {
    expect(js).toMatch(/MAX_ADDRESSES\s*=\s*8/);
    expect(js).toMatch(/addresses\.push/);
    // New address keeps the old ones rather than replacing.
    expect(js).not.toMatch(/addresses\s*=\s*\[\s*data\.address\s*\]/);
  });

  it('polls every held address and merges, tagging each message with its inbox', () => {
    // The union is the point: a single-address poll would defeat the wallet.
    expect(js).toMatch(/addresses\.slice\(\)|held\.map/);
    expect(js).toMatch(/m\.inbox\s*=\s*r\.addr/);
    expect(js).toMatch(/msgInbox\[/);
  });

  it('remembers the whole list across a refresh, migrating the old single key', () => {
    expect(js).toContain("'loc1999-mail-addresses'");
    expect(js).toMatch(/LEGACY_KEY|loc1999-mail-address['"]/);
  });
});
