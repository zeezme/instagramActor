/* eslint-disable no-underscore-dangle */
import { Actor, Dataset } from 'apify';
import { PuppeteerCrawler, RequestList } from 'crawlee';
import * as fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCookies(cookies: string) {
    return cookies.split(';').map((cookie) => {
        const [name, ...rest] = cookie.split('=');
        const value = rest.join('=').trim();
        return { name: name.trim(), value, domain: '.instagram.com' };
    });
}

await Actor.init();

interface Input {
    storyUrls: { url: string }[];
    cookies: string;
    proxyUrl: string;
}

const { storyUrls, cookies, proxyUrl } = (await Actor.getInput<Input>()) ?? {};

if (!cookies || !proxyUrl) {
    throw new Error('Cookies and proxyUrl must be provided.');
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    proxyUrls: [proxyUrl],
});

const parsedCookies = parseCookies(cookies);

const uniqueRequestListName = `story-urls-${new Date().getTime()}`;
const requestList = await RequestList.open(uniqueRequestListName, storyUrls);

const crawler = new PuppeteerCrawler({
    requestList,
    proxyConfiguration,
    preNavigationHooks: [
        async ({ page }) => {
            await page.setCookie(...parsedCookies);
        },
    ],
    requestHandler: async ({ page, request }) => {
        await page.goto(request.url, { waitUntil: 'networkidle0' });

        await page.setViewport({ width: 600, height: 1000 });

        await page.waitForSelector('div[role="button"][tabindex="0"]', {
            timeout: 5000,
        });

        const viewStoryButtonClicked = await page.evaluate(() => {
            const buttons = Array.from(
                document.querySelectorAll('div[role="button"][tabindex="0"]'),
            );
            const viewStoryButton = buttons.find((btn) =>
                (btn as HTMLElement).innerText.includes('View story'),
            );
            if (viewStoryButton) {
                (viewStoryButton as HTMLElement).click();
                return true;
            }
            return false;
        });

        if (!viewStoryButtonClicked) {
            throw new Error('Botão "View story" não encontrado.');
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const username = await page
            .$eval(
                'a[role="link"][href*="/"]',
                (el) => el.getAttribute('href')?.replace(/\//g, '') || null,
            )
            .catch(() => null);

        const profilePicture = await page
            .$eval('a[role="link"] img', (img) => img.src || null)
            .catch(() => null);

        const isVerified = await page
            .evaluate(() => {
                const svgElements = Array.from(
                    document.querySelectorAll('svg'),
                );
                return svgElements.some((svg) => {
                    const pathElement = svg.querySelector('path[d^="M19.998"]');
                    return pathElement !== null;
                });
            })
            .catch(() => false);

        const timestamp = await page
            .$eval('time', (el) => el.getAttribute('datetime') || null)
            .catch(() => null);

        const songData = await page
            .$eval(
                'span.xuxw1ft[class="xuxw1ft"]',
                (el) => el.textContent?.trim().replace(' ·', '') || null,
            )
            .catch(() => null);

        const mediaData = await page.evaluate(() => {
            const images = Array.from(
                document.querySelectorAll(
                    'img[src*="https://scontent.cdninstagram.com"][alt]',
                ),
            ).map((img) => ({
                type: 'image',
                mediaUrl: img.getAttribute('src') || null,
                altText: img.getAttribute('alt') || null,
            }));

            const videos = Array.from(
                document.querySelectorAll(
                    'video[src*="https://scontent.cdninstagram.com"]',
                ),
            ).map((video) => ({
                type: 'video',
                mediaUrl: video.getAttribute('src') || null,
            }));

            return [...images, ...videos];
        });

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const screenshotFileName = `screenshot-${request.url
            .split('/')
            .filter(Boolean)
            .pop()}.png`;
        const localFilePath = path.join(__dirname, screenshotFileName);

        // Captura o screenshot apenas do story, usando o bounding box
        const storyElement = await page.$('div[role="dialog"]');
        const boundingBox = await storyElement?.boundingBox();
        if (boundingBox) {
            await page.screenshot({ path: localFilePath, clip: boundingBox });
        } else {
            // Se o boundingBox falhar, captura a tela toda
            await page.screenshot({ path: localFilePath });
        }

        const screenshotBuffer = await fs.readFile(localFilePath);
        await Actor.setValue(screenshotFileName, screenshotBuffer, {
            contentType: 'image/png',
        });

        await fs.unlink(localFilePath);

        await Dataset.pushData({
            username,
            profilePicture,
            isVerified,
            timestamp,
            songData,
            mediaData,
            screenshotFileName,
            storyId: request.url.split('/').filter(Boolean).pop(),
        });
    },
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
});

await crawler.run();
await Actor.exit();
