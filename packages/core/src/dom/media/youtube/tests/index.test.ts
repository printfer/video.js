import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildYouTubeIframeSrc,
  parseYouTubeVideoId,
  YouTubeMedia,
  type YouTubePlayerApi,
  youtubeMediaDefaultProps,
} from '..';

class MockPlayer implements YouTubePlayerApi {
  static instances: MockPlayer[] = [];

  target: HTMLIFrameElement;
  events: PlayerEvents;
  currentTime = 0;
  duration = 60;
  loadedFraction = 0;
  volume = 100;
  muted = false;
  playbackRate = 1;
  playerState = 5;

  playVideo = vi.fn();
  pauseVideo = vi.fn();
  cueVideoById = vi.fn();
  loadVideoById = vi.fn();
  seekTo = vi.fn((seconds: number) => {
    this.currentTime = seconds;
  });
  getCurrentTime = vi.fn(() => this.currentTime);
  getDuration = vi.fn(() => this.duration);
  getVideoLoadedFraction = vi.fn(() => this.loadedFraction);
  getVolume = vi.fn(() => this.volume);
  setVolume = vi.fn((volume: number) => {
    this.volume = volume;
  });
  isMuted = vi.fn(() => this.muted);
  mute = vi.fn(() => {
    this.muted = true;
  });
  unMute = vi.fn(() => {
    this.muted = false;
  });
  getPlaybackRate = vi.fn(() => this.playbackRate);
  setPlaybackRate = vi.fn((rate: number) => {
    this.playbackRate = rate;
  });
  getPlayerState = vi.fn(() => this.playerState);
  destroy = vi.fn();

  constructor(target: HTMLIFrameElement, options: { events: PlayerEvents }) {
    this.target = target;
    this.events = options.events;
    MockPlayer.instances.push(this);
  }

  ready(): void {
    this.events.onReady();
  }

  state(data: number): void {
    this.playerState = data;
    this.events.onStateChange({ data });
  }

  rate(data: number): void {
    this.events.onPlaybackRateChange({ data });
  }

  error(data: number): void {
    this.events.onError({ data });
  }

  blocked(): void {
    this.events.onAutoplayBlocked();
  }
}

interface PlayerEvents {
  onReady(): void;
  onStateChange(event: { data: number }): void;
  onPlaybackRateChange(event: { data: number }): void;
  onAutoplayBlocked(): void;
  onError(event: { data: number }): void;
}

async function attach(media: YouTubeMedia): Promise<{ iframe: HTMLIFrameElement; player: MockPlayer }> {
  const iframe = document.createElement('iframe');
  media.attach(iframe);
  await vi.waitFor(() => expect(MockPlayer.instances).toHaveLength(1));
  return { iframe, player: MockPlayer.instances[0] };
}

beforeEach(() => {
  MockPlayer.instances = [];
  globalThis.YT = { Player: MockPlayer };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseYouTubeVideoId', () => {
  it.each([
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=12', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts an id from %s', (src, expected) => {
    expect(parseYouTubeVideoId(src)).toBe(expected);
  });

  it('rejects invalid and non-YouTube sources', () => {
    expect(parseYouTubeVideoId('')).toBe(null);
    expect(parseYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBe(null);
    expect(parseYouTubeVideoId('not-a-video-id')).toBe(null);
  });
});

describe('buildYouTubeIframeSrc', () => {
  it('uses privacy-enhanced mode and player defaults', () => {
    const src = buildYouTubeIframeSrc('dQw4w9WgXcQ');

    expect(src).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?');
    expect(src).toContain('enablejsapi=1');
    expect(src).toContain('controls=0');
    expect(src).toContain('playsinline=1');
  });

  it('supports the standard cookie domain', () => {
    const src = buildYouTubeIframeSrc('dQw4w9WgXcQ', { config: { cookies: true } });

    expect(src).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ?');
    expect(src).not.toContain('cookies=');
  });

  it('forwards embed parameters while reserving wrapper configuration', () => {
    const src = buildYouTubeIframeSrc('dQw4w9WgXcQ', {
      autoplay: true,
      defaultMuted: true,
      loop: true,
      controls: true,
      config: { color: 'white', disablekb: 1, referrerPolicy: 'origin' },
    });

    expect(src).toContain('autoplay=1');
    expect(src).toContain('mute=1');
    expect(src).toContain('loop=1');
    expect(src).toContain('playlist=dQw4w9WgXcQ');
    expect(src).toContain('controls=1');
    expect(src).toContain('color=white');
    expect(src).toContain('disablekb=1');
    expect(src).not.toContain('referrerPolicy=');
  });

  it('returns an empty string for an invalid source', () => {
    expect(buildYouTubeIframeSrc('not-a-video-id')).toBe('');
  });
});

describe('YouTubeMedia', () => {
  it('has expected default state before attach', () => {
    const media = new YouTubeMedia();

    expect(media.engine).toBe(null);
    expect(media.target).toBe(null);
    expect(media.paused).toBe(true);
    expect(media.ended).toBe(false);
    expect(media.currentTime).toBe(0);
    expect(media.duration).toBeNaN();
    expect(media.src).toBe(youtubeMediaDefaultProps.src);
    expect(media.buffered.length).toBe(0);
  });

  it('creates a player and maps ready state to media events', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const events: string[] = [];
    for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'loadcomplete']) {
      media.addEventListener(type, () => events.push(type));
    }

    const { iframe, player } = await attach(media);
    player.ready();

    expect(media.target).toBe(iframe);
    expect(media.engine).toBe(player);
    expect(media.readyState).toBe(4);
    expect(media.duration).toBe(60);
    expect(events).toEqual(
      expect.arrayContaining(['loadstart', 'loadedmetadata', 'canplay', 'canplaythrough', 'loadcomplete'])
    );
    media.destroy();
  });

  it('forwards playback, seek, volume, mute, and rate commands', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { player } = await attach(media);
    player.ready();

    const play = media.play();
    await Promise.resolve();
    player.state(1);
    await play;
    media.pause();
    media.currentTime = 12;
    media.volume = 0.4;
    media.muted = true;
    media.playbackRate = 1.5;
    await Promise.resolve();

    expect(player.playVideo).toHaveBeenCalled();
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(player.seekTo).toHaveBeenCalledWith(12, true);
    expect(player.setVolume).toHaveBeenCalledWith(40);
    expect(player.mute).toHaveBeenCalled();
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.5);
    media.destroy();
  });

  it('maps YouTube player states to media state and events', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { player } = await attach(media);
    player.ready();
    const events: string[] = [];
    for (const type of ['play', 'playing', 'waiting', 'pause', 'ended']) {
      media.addEventListener(type, () => events.push(type));
    }

    player.state(1);
    player.state(3);
    player.state(2);
    player.state(0);

    expect(events).toEqual(['play', 'playing', 'waiting', 'pause', 'ended']);
    expect(media.paused).toBe(true);
    expect(media.ended).toBe(true);
    media.destroy();
  });

  it('cues replacement sources and destroys the player on detach', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { player } = await attach(media);
    player.ready();

    media.src = 'M7lc1UVf-VE';
    await Promise.resolve();

    expect(player.cueVideoById).toHaveBeenCalledWith('M7lc1UVf-VE');
    media.detach();
    expect(player.destroy).toHaveBeenCalled();
    expect(media.engine).toBe(null);
  });

  it('uses the latest source when it changes while the API initializes', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const iframe = document.createElement('iframe');

    media.attach(iframe);
    media.src = 'M7lc1UVf-VE';
    await vi.waitFor(() => expect(MockPlayer.instances).toHaveLength(1));

    expect(iframe.src).toContain('M7lc1UVf-VE');
    media.destroy();
  });

  it('does not create a stale player when detached during initialization', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    media.attach(document.createElement('iframe'));

    media.detach();
    await Promise.resolve();

    expect(MockPlayer.instances).toHaveLength(0);
  });

  it('clears the active player when given an invalid source', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { iframe, player } = await attach(media);
    player.ready();

    media.src = 'not-a-video-id';

    expect(player.destroy).toHaveBeenCalled();
    expect(media.engine).toBe(null);
    expect(iframe.hasAttribute('src')).toBe(false);
  });

  it('rejects play when YouTube blocks playback', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { player } = await attach(media);
    player.ready();

    const play = media.play();
    await Promise.resolve();
    player.blocked();

    await expect(play).rejects.toMatchObject({ name: 'NotAllowedError' });
    media.destroy();
  });

  it('rejects play after a terminal provider error', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const { player } = await attach(media);
    player.error(150);

    await expect(media.play()).rejects.toThrow('YouTube playback error (150)');
    media.destroy();
  });

  it('exposes provider errors as media errors', async () => {
    const media = new YouTubeMedia();
    media.src = 'dQw4w9WgXcQ';
    const error = vi.fn();
    media.addEventListener('error', error);
    const { player } = await attach(media);

    player.error(150);

    expect(media.error).toEqual({ code: 4, message: 'YouTube playback error (150)' });
    expect(error).toHaveBeenCalledOnce();
    media.destroy();
  });
});
