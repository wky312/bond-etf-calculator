// Scrape CME FedWatch Tool probabilities using Playwright
// Targets the Dec 9, 2026 FOMC meeting
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html';
const OUTPUT = path.join(__dirname, '..', 'data', 'fedwatch.json');

// Target meeting: 9 Dec 2026
const TARGET_MEETING = '9 Dec 2026';
const TARGET_MEETING_ALT = ['Dec 2026', '12/2026', '2026-12-09', 'December 2026'];

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log('Navigating to CME FedWatch...');
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Dismiss cookie/consent banners if present
    try {
      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("Agree")').first();
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (_) {}

    // Wait for the FedWatch tool to load
    await page.waitForTimeout(5000);

    // Try to find and click the target meeting date
    console.log('Looking for meeting date selector...');
    let foundMeeting = false;

    // Strategy 1: Look for a dropdown/select with meeting dates
    const dropdowns = page.locator('select, [role="listbox"], [role="combobox"]');
    const dropdownCount = await dropdowns.count();
    for (let i = 0; i < dropdownCount && !foundMeeting; i++) {
      const dd = dropdowns.nth(i);
      const text = await dd.textContent().catch(() => '');
      if (text.includes('2026') || text.includes('Dec')) {
        // Try to select the target meeting
        try {
          await dd.selectOption({ label: TARGET_MEETING });
          foundMeeting = true;
        } catch (_) {
          for (const alt of TARGET_MEETING_ALT) {
            try {
              await dd.selectOption({ label: alt });
              foundMeeting = true;
              break;
            } catch (_) {}
          }
        }
      }
    }

    // Strategy 2: Look for clickable tabs/buttons with meeting dates
    if (!foundMeeting) {
      const meetingBtns = page.locator('button, [role="tab"], a, .meeting-date, [class*="meeting"], [class*="date"]');
      const btnCount = await meetingBtns.count();
      for (let i = 0; i < btnCount && !foundMeeting; i++) {
        const btn = meetingBtns.nth(i);
        const text = await btn.textContent().catch(() => '');
        if (text.includes('9 Dec') || text.includes('Dec 2026') || text.includes('12/9/2026')) {
          await btn.click();
          foundMeeting = true;
          console.log('Clicked meeting date:', text.trim());
        }
      }
    }

    // Strategy 3: Navigate to specific URL with meeting parameter
    if (!foundMeeting) {
      console.log('Trying direct URL navigation...');
      // CME sometimes uses URL parameters for meeting selection
      await page.goto(URL + '?date=2026-12-09', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    await page.waitForTimeout(3000);

    // ── Extract probability data ──
    console.log('Extracting probability data...');

    // Strategy A: Intercept network requests for probability data
    let probData = null;

    // Strategy B: Parse the visible table on the page
    // Look for a table with TARGET RATE and probability percentages
    probData = await page.evaluate(() => {
      const result = {};

      // Find all tables
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const text = table.textContent;
        if (text.includes('TARGET RATE') || text.includes('target rate') || text.includes('350-375') || text.includes('325-350')) {
          const rows = table.querySelectorAll('tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              const rateText = cells[0]?.textContent?.trim() || '';
              // Look for rate range patterns like "350-375" or "3.50-3.75"
              const rangeMatch = rateText.match(/(\d{3})\s*[-–]\s*(\d{3})/) || rateText.match(/(\d\.\d{2})\s*[-–]\s*(\d\.\d{2})/);
              if (rangeMatch) {
                // Find the probability value (last column or the "NOW" column)
                const lastCell = cells[cells.length - 1];
                const pctMatch = lastCell?.textContent?.match(/([\d.]+)\s*%/);
                if (pctMatch) {
                  result[rateText.trim()] = parseFloat(pctMatch[1]);
                }
              }
            }
          }
        }
      }

      // Also try extracting from non-table elements (divs, spans with specific patterns)
      if (Object.keys(result).length === 0) {
        // Look for elements containing rate-probability pairs
        const allText = document.body.innerText;
        const matches = allText.matchAll(/(\d{3}\s*[-–]\s*\d{3})[^\d]*([\d.]+)\s*%/g);
        for (const m of matches) {
          result[m[1].replace(/\s/g, '')] = parseFloat(m[2]);
        }
      }

      return Object.keys(result).length > 0 ? result : null;
    });

    // Strategy C: Try to get data from page's JavaScript state
    if (!probData) {
      probData = await page.evaluate(() => {
        // Some SPAs store data in window or global state
        if (window.__FEDWATCH_DATA__) return window.__FEDWATCH_DATA__;
        if (window.__NEXT_DATA__) {
          const s = JSON.stringify(window.__NEXT_DATA__);
          if (s.includes('probability') || s.includes('350-375')) return window.__NEXT_DATA__;
        }
        return null;
      });
    }

    if (!probData || Object.keys(probData).length < 2) {
      // Take a screenshot for debugging
      await page.screenshot({ path: path.join(__dirname, '..', 'data', 'debug-screenshot.png'), fullPage: true });
      console.error('Failed to extract probability data. Screenshot saved to data/debug-screenshot.png');

      // Dump page content for debugging
      const bodyText = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync(path.join(__dirname, '..', 'data', 'debug-page-text.txt'), bodyText);
      console.error('Page text saved to data/debug-page-text.txt');

      process.exit(1);
    }

    // ── Normalize to standard format ──
    // Convert rate ranges to cut bps: {0: prob, 25: prob, 50: prob, ...}
    console.log('Raw data:', JSON.stringify(probData));

    const entries = Object.entries(probData).sort((a, b) => {
      // Sort by rate range descending (highest rate = no change)
      const aNum = parseInt(a[0].replace(/[^0-9]/g, ''));
      const bNum = parseInt(b[0].replace(/[^0-9]/g, ''));
      return bNum - aNum;
    });

    const probabilities = {};
    entries.forEach(([range, prob], i) => {
      probabilities[i * 25] = prob;
    });

    // Validate
    const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
    if (total < 90 || total > 110) {
      console.error('Probabilities sum to', total, '- seems invalid');
      process.exit(1);
    }

    // Find current rate (highest rate range in the data)
    const highestRange = entries[0][0];
    const hiMatch = highestRange.match(/(\d{3})\s*[-–]\s*(\d{3})/);
    let currentTargetHi = null;
    if (hiMatch) {
      currentTargetHi = parseInt(hiMatch[2]) / 100;
    }

    const output = {
      probabilities,
      rateRanges: Object.fromEntries(entries),
      currentTargetHi,
      meeting: TARGET_MEETING,
      timestamp: new Date().toISOString(),
      source: 'CME FedWatch Tool (Playwright scrape)',
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log('Saved to', OUTPUT);
    console.log('Probabilities:', JSON.stringify(probabilities));
    console.log('Total:', total.toFixed(1) + '%');

  } catch (err) {
    console.error('Scrape failed:', err.message);
    // Save screenshot on error
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'data', 'debug-screenshot.png'), fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
