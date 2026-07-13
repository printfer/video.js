import { EMPTY_TEXT_TRACKS, EMPTY_TIME_RANGES } from '../../../core/media/constants';
import type { ErrorLike, MediaPreloadType, TextTrackListLike, Video } from '../../../core/media/types';
import { MediaPlayedRangesMixin } from '../media-played-ranges';

export type YouTubeEmbedParameter = boolean | number | string | null | undefined;

/** Public YouTube embed configuration. Unknown keys are forwarded as player parameters. */
export interface YouTubeConfig {
  /** Use the standard YouTube domain instead of privacy-enhanced mode. */
  cookies?: boolean;
  referrerPolicy?: ReferrerPolicy;
  [key: string]: YouTubeEmbedParameter;
}

export interface YouTubeMediaProps {
  src: string;
  autoplay: boolean;
  defaultMuted: boolean;
  muted: boolean;
  loop: boolean;
  controls: boolean;
  playsInline: boolean;
  preload: MediaPreloadType;
  poster: string;
  config: YouTubeConfig;
}

export const youtubeMediaDefaultProps: YouTubeMediaProps = {
  src: '',
  autoplay: false,
  defaultMuted: false,
  muted: false,
  loop: false,
  controls: false,
  playsInline: true,
  preload: 'metadata',
  poster: '',
  config: {},
};

const YouTubeMediaBase = MediaPlayedRangesMixin(EventTarget);

export class YouTubeMedia extends YouTubeMediaBase implements Partial<Video> {
  #target: HTMLIFrameElement | null = null;
  #player: YouTubePlayerApi | null = null;
  #playerReady = createPublicPromise<void>();
  #attachToken = 0;
  #initializing = false;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #playRequest: PublicPromise<void> | null = null;
  #seekTarget: number | null = null;
  #seekTimer: ReturnType<typeof setTimeout> | null = null;

  #src = youtubeMediaDefaultProps.src;
  #autoplay = youtubeMediaDefaultProps.autoplay;
  #defaultMuted = youtubeMediaDefaultProps.defaultMuted;
  #loop = youtubeMediaDefaultProps.loop;
  #controls = youtubeMediaDefaultProps.controls;
  #playsInline = youtubeMediaDefaultProps.playsInline;
  #preload = youtubeMediaDefaultProps.preload;
  #poster = youtubeMediaDefaultProps.poster;
  #config = youtubeMediaDefaultProps.config;

  #paused = true;
  #ended = false;
  #seeking = false;
  #currentTime = 0;
  #duration = Number.NaN;
  #volume = 1;
  #muted = false;
  #playbackRate = 1;
  #progress = 0;
  #readyState = READY_STATE_HAVE_NOTHING;
  #error: ErrorLike | null = null;

  static PLAYER_SOFTWARE_NAME = 'youtube-video';

  /** Underlying YouTube iframe API player (null before the API is ready). */
  get engine() {
    return this.#player;
  }

  get target() {
    return this.#target;
  }

  /** Bind the iframe hosting the embed, loading the YouTube iframe API as needed. */
  attach(target: HTMLIFrameElement | null): void {
    if (!target || this.#target === target) return;
    if (this.#target) this.detach();

    const token = ++this.#attachToken;
    this.#target = target;
    this.#playerReady = createPublicPromise<void>();
    if (!target.src) {
      const initialSrc = buildYouTubeIframeSrc(this.#src, this.#snapshotProps());
      if (initialSrc) target.src = initialSrc;
    }
    this.dispatchEvent(new Event('loadstart'));
    if (parseYouTubeVideoId(this.#src)) this.#initializePlayer(target, token);
  }

  detach(): void {
    if (!this.#target) return;
    this.#attachToken++;
    this.#initializing = false;
    this.#stopPolling();
    this.#clearSeekTimer();
    this.#rejectPlay(new DOMException('YouTube player detached', 'AbortError'));
    this.#player?.destroy();
    this.#player = null;
    this.#target = null;
    this.#playerReady.resolve();
    this.#resetState();
  }

  override destroy(): void {
    this.detach();
    super.destroy();
  }

  get src() {
    return this.#src;
  }
  set src(value) {
    if (this.#src === value) return;
    this.#src = value;
    void this.load();
  }

  get currentSrc() {
    return this.#target?.src ?? '';
  }

  get readyState() {
    return this.#readyState;
  }

  async load(): Promise<void> {
    const id = parseYouTubeVideoId(this.#src);
    const target = this.#target;
    if (!target) return;
    if (!id) {
      this.#attachToken++;
      this.#initializing = false;
      this.#stopPolling();
      this.#clearSeekTimer();
      this.#rejectPlay(new DOMException('Media source changed', 'AbortError'));
      this.#player?.destroy();
      this.#player = null;
      this.#playerReady.resolve();
      this.#playerReady = createPublicPromise<void>();
      target.removeAttribute('src');
      this.#resetState();
      this.dispatchEvent(new Event('emptied'));
      return;
    }
    if (!this.#player) {
      target.src = buildYouTubeIframeSrc(this.#src, this.#snapshotProps());
      this.#initializePlayer(target, this.#attachToken);
      return;
    }
    const player = this.#player;
    const token = this.#attachToken;
    this.#resetState();
    this.dispatchEvent(new Event('emptied'));
    this.dispatchEvent(new Event('loadstart'));
    await this.#playerReady;
    if (this.#attachToken !== token || this.#player !== player) return;
    if (this.#autoplay) player.loadVideoById(id);
    else player.cueVideoById(id);
  }

  get paused() {
    return this.#paused;
  }

  get ended() {
    return this.#ended;
  }

  get seeking() {
    return this.#seeking;
  }

  async play(): Promise<void> {
    if (!this.#target) throw new DOMException('YouTube player is not attached', 'InvalidStateError');
    await this.#playerReady;
    if (this.#error) throw new Error(this.#error.message);
    const player = this.#player;
    if (!player) throw new DOMException('YouTube player is not attached', 'InvalidStateError');
    if (player.getPlayerState() === PLAYER_STATE_PLAYING) return;
    this.#rejectPlay(new DOMException('Play request superseded', 'AbortError'));
    this.#playRequest = createPublicPromise<void>();
    player.playVideo();
    return this.#playRequest;
  }

  pause(): void {
    this.#rejectPlay(new DOMException('Play request interrupted', 'AbortError'));
    this.#player?.pauseVideo();
  }

  get currentTime() {
    return this.#currentTime;
  }
  set currentTime(value) {
    if (this.#currentTime === value) return;
    this.#currentTime = value;
    this.#seeking = true;
    this.#seekTarget = value;
    this.#clearSeekTimer();
    this.dispatchEvent(new Event('seeking'));
    this.#afterReady((player) => {
      this.#seekTimer = setTimeout(() => this.#finishSeek(), 3000);
      player.seekTo(value, true);
      this.#syncState();
    });
  }

  get duration() {
    return this.#duration;
  }

  get volume() {
    return this.#volume;
  }
  set volume(value) {
    const next = Math.max(0, Math.min(value, 1));
    if (this.#volume === next) return;
    this.#volume = next;
    this.#afterReady((player) => player.setVolume(next * 100));
    this.dispatchEvent(new Event('volumechange'));
  }

  get muted() {
    return this.#muted;
  }
  set muted(value) {
    if (this.#muted === value) return;
    this.#muted = value;
    this.#afterReady((player) => (value ? player.mute() : player.unMute()));
    this.dispatchEvent(new Event('volumechange'));
  }

  get playbackRate() {
    return this.#playbackRate;
  }
  set playbackRate(value) {
    if (this.#playbackRate === value) return;
    this.#playbackRate = value;
    this.#afterReady((player) => player.setPlaybackRate(value));
  }

  get autoplay() {
    return this.#autoplay;
  }
  set autoplay(value) {
    this.#autoplay = value;
  }

  get defaultMuted() {
    return this.#defaultMuted;
  }
  set defaultMuted(value) {
    this.#defaultMuted = value;
  }

  get loop() {
    return this.#loop;
  }
  set loop(value) {
    this.#loop = value;
  }

  get controls() {
    return this.#controls;
  }
  set controls(value) {
    this.#controls = value;
  }

  get playsInline() {
    return this.#playsInline;
  }
  set playsInline(value) {
    this.#playsInline = value;
  }

  get preload() {
    return this.#preload;
  }
  set preload(value) {
    this.#preload = value;
  }

  get poster() {
    return this.#poster;
  }
  set poster(value) {
    this.#poster = value;
  }

  get config() {
    return this.#config as Record<string, unknown>;
  }
  set config(value) {
    this.#config = value as YouTubeConfig;
  }

  get buffered() {
    return this.#progress > 0 ? createTimeRanges(0, this.#progress) : EMPTY_TIME_RANGES;
  }

  get seekable() {
    return this.#duration > 0 && Number.isFinite(this.#duration)
      ? createTimeRanges(0, this.#duration)
      : EMPTY_TIME_RANGES;
  }

  get error() {
    return this.#error;
  }

  get textTracks(): TextTrackListLike {
    return EMPTY_TEXT_TRACKS;
  }

  #snapshotProps(): Partial<YouTubeMediaProps> {
    return {
      autoplay: this.#autoplay,
      defaultMuted: this.#defaultMuted,
      loop: this.#loop,
      controls: this.#controls,
      playsInline: this.#playsInline,
      config: this.#config,
    };
  }

  #initializePlayer(target: HTMLIFrameElement, token: number): void {
    if (this.#initializing || this.#player) return;
    this.#initializing = true;
    loadYouTubeIframeApi().then(
      (api) => {
        if (this.#attachToken !== token || this.#target !== target) return;
        this.#initializing = false;
        try {
          this.#player = new api.Player(target, {
            events: {
              onReady: () => this.#onReady(token),
              onStateChange: (event) => this.#onStateChange(token, event.data),
              onPlaybackRateChange: (event) => this.#onPlaybackRateChange(token, event.data),
              onAutoplayBlocked: () => this.#onAutoplayBlocked(token),
              onError: (event) => this.#onError(token, event.data),
            },
          });
        } catch {
          this.#onError(token, 0);
        }
      },
      () => {
        this.#initializing = false;
        this.#onError(token, 0);
      }
    );
  }

  #afterReady(fn: (player: YouTubePlayerApi) => void): void {
    const ready = this.#playerReady;
    const token = this.#attachToken;
    ready.then(() => {
      if (this.#attachToken === token && this.#player) fn(this.#player);
    });
  }

  #onReady(token: number): void {
    if (token !== this.#attachToken) return;
    const player = this.#player;
    if (!player) return;
    if (this.#defaultMuted || this.#muted) player.mute();
    this.#syncState();
    this.#playerReady.resolve();
    this.#startPolling();
    this.dispatchEvent(new Event('volumechange'));
    if (this.#duration > 0) this.#markLoaded();
    this.#onStateChange(token, player.getPlayerState());
  }

  #onStateChange(token: number, state: number): void {
    if (token !== this.#attachToken) return;
    const emit = (type: string) => this.dispatchEvent(new Event(type));
    this.#syncState();

    if (state === PLAYER_STATE_PLAYING) {
      this.#markLoaded();
      this.#readyState = READY_STATE_HAVE_ENOUGH_DATA;
      const wasPaused = this.#paused;
      this.#paused = false;
      this.#ended = false;
      if (wasPaused) emit('play');
      emit('playing');
      this.#playRequest?.resolve();
      this.#playRequest = null;
    } else if (state === PLAYER_STATE_PAUSED) {
      this.#markLoaded();
      this.#paused = true;
      emit('pause');
    } else if (state === PLAYER_STATE_BUFFERING) {
      this.#markLoaded();
      this.#readyState = READY_STATE_HAVE_CURRENT_DATA;
      emit('waiting');
    } else if (state === PLAYER_STATE_ENDED) {
      if (this.#loop) {
        this.#player?.playVideo();
        return;
      }
      this.#paused = true;
      this.#ended = true;
      emit('ended');
    } else if (state === PLAYER_STATE_CUED) this.#markLoaded();
  }

  #onPlaybackRateChange(token: number, rate: number): void {
    if (token !== this.#attachToken) return;
    this.#playbackRate = rate;
    this.dispatchEvent(new Event('ratechange'));
  }

  #onAutoplayBlocked(token: number): void {
    if (token !== this.#attachToken) return;
    this.#rejectPlay(new DOMException('YouTube playback was blocked', 'NotAllowedError'));
  }

  #onError(token: number, code: number): void {
    if (token !== this.#attachToken) return;
    this.#error = { code: 4, message: `YouTube playback error (${code})` };
    this.#playerReady.resolve();
    this.#rejectPlay(new Error(this.#error.message));
    this.dispatchEvent(new Event('error'));
  }

  #markLoaded(): void {
    if (this.#readyState >= READY_STATE_HAVE_METADATA) return;
    this.#readyState = READY_STATE_HAVE_ENOUGH_DATA;
    for (const type of ['loadedmetadata', 'canplay', 'canplaythrough', 'loadcomplete']) {
      this.dispatchEvent(new Event(type));
    }
  }

  #syncState(): void {
    const player = this.#player;
    if (!player) return;
    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    const progress = duration * player.getVideoLoadedFraction();

    if (Number.isFinite(currentTime)) this.#currentTime = currentTime;
    if (this.#seekTarget !== null && Math.abs(this.#currentTime - this.#seekTarget) <= 0.5) this.#finishSeek();
    if (Number.isFinite(duration) && duration !== this.#duration) {
      this.#duration = duration;
      this.dispatchEvent(new Event('durationchange'));
    }
    if (duration > 0 && this.#readyState === READY_STATE_HAVE_NOTHING) this.#markLoaded();
    if (Number.isFinite(progress) && progress !== this.#progress) {
      this.#progress = progress;
      this.dispatchEvent(new Event('progress'));
    }
    this.#volume = player.getVolume() / 100;
    this.#muted = player.isMuted();
    this.#playbackRate = player.getPlaybackRate();
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#pollTimer = setInterval(() => {
      const previousTime = this.#currentTime;
      this.#syncState();
      if (this.#currentTime !== previousTime) this.dispatchEvent(new Event('timeupdate'));
    }, 250);
  }

  #stopPolling(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  #finishSeek(): void {
    if (!this.#seeking) return;
    this.#clearSeekTimer();
    this.#seekTarget = null;
    this.#seeking = false;
    this.dispatchEvent(new Event('seeked'));
    this.dispatchEvent(new Event('timeupdate'));
  }

  #clearSeekTimer(): void {
    if (this.#seekTimer) clearTimeout(this.#seekTimer);
    this.#seekTimer = null;
  }

  #rejectPlay(reason: unknown): void {
    this.#playRequest?.reject(reason);
    this.#playRequest = null;
  }

  #resetState(): void {
    this.#clearSeekTimer();
    this.#rejectPlay(new DOMException('Media source changed', 'AbortError'));
    this.#paused = !this.#autoplay;
    this.#ended = false;
    this.#seeking = false;
    this.#seekTarget = null;
    this.#currentTime = 0;
    this.#duration = Number.NaN;
    this.#volume = 1;
    this.#muted = false;
    this.#playbackRate = 1;
    this.#progress = 0;
    this.#readyState = READY_STATE_HAVE_NOTHING;
    this.#error = null;
  }
}

/** Extract a video id from a YouTube id or URL. */
export function parseYouTubeVideoId(src: string): string | null {
  if (VIDEO_ID.test(src)) return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^www\./, '');
  if (hostname === 'youtu.be') return validVideoId(url.pathname.split('/')[1]);
  if (!YOUTUBE_HOSTS.has(hostname)) return null;
  if (url.pathname === '/watch') return validVideoId(url.searchParams.get('v'));
  const [, kind, id] = url.pathname.split('/');
  return kind === 'embed' || kind === 'shorts' || kind === 'live' ? validVideoId(id) : null;
}

/** Build the iframe `src` URL for an initial YouTube embed from the given props. */
export function buildYouTubeIframeSrc(src: string, props: Partial<YouTubeMediaProps> = {}): string {
  const id = parseYouTubeVideoId(src);
  if (!id) return '';
  const config = { ...(props.config ?? {}) };
  const cookies = config.cookies === true;
  delete config.cookies;
  delete config.referrerPolicy;

  const params: Record<string, YouTubeEmbedParameter> = {
    ...config,
    enablejsapi: 1,
    autoplay: props.autoplay ?? youtubeMediaDefaultProps.autoplay,
    controls: props.controls ?? youtubeMediaDefaultProps.controls,
    playsinline: props.playsInline ?? youtubeMediaDefaultProps.playsInline,
    loop: props.loop ?? youtubeMediaDefaultProps.loop,
    playlist: props.loop ? id : null,
    mute: props.defaultMuted ?? youtubeMediaDefaultProps.defaultMuted,
    origin: getPageOrigin(),
  };
  const host = cookies ? YOUTUBE_EMBED_HOST : YOUTUBE_NO_COOKIE_EMBED_HOST;
  return `${host}/${id}?${serialize(params)}`;
}

const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);
const YOUTUBE_EMBED_HOST = 'https://www.youtube.com/embed';
const YOUTUBE_NO_COOKIE_EMBED_HOST = 'https://www.youtube-nocookie.com/embed';
const PLAYER_STATE_ENDED = 0;
const PLAYER_STATE_PLAYING = 1;
const PLAYER_STATE_PAUSED = 2;
const PLAYER_STATE_BUFFERING = 3;
const PLAYER_STATE_CUED = 5;
const READY_STATE_HAVE_NOTHING = 0;
const READY_STATE_HAVE_METADATA = 1;
const READY_STATE_HAVE_CURRENT_DATA = 2;
const READY_STATE_HAVE_ENOUGH_DATA = 4;

function validVideoId(value: string | null | undefined): string | null {
  return value && VIDEO_ID.test(value) ? value : null;
}

function getPageOrigin(): string | null {
  const origin = globalThis.location?.origin;
  return origin && origin !== 'null' ? origin : null;
}

function createTimeRanges(start: number, end: number) {
  return { length: 1, start: () => start, end: () => end };
}

function serialize(props: Record<string, YouTubeEmbedParameter>): string {
  const params = new URLSearchParams();
  for (const key in props) {
    const value = props[key];
    if (value === true || value === '') params.set(key, '1');
    else if (value === false) params.set(key, '0');
    else if (value != null) params.set(key, String(value));
  }
  return params.toString();
}

let iframeApiPromise: Promise<YouTubeIframeApi> | null = null;

function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (iframeApiPromise) return iframeApiPromise;

  const promise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    const previous = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (globalThis.YT?.Player) resolve(globalThis.YT);
      else reject(new Error('YouTube iframe API did not initialize'));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    const script = existing ?? document.createElement('script');
    script.addEventListener(
      'error',
      () => {
        script.remove();
        reject(new Error('Failed to load YouTube iframe API'));
      },
      { once: true }
    );
    if (existing) return;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    document.head.append(script);
  });

  iframeApiPromise = promise.catch((error: unknown) => {
    iframeApiPromise = null;
    throw error;
  });

  return iframeApiPromise;
}

interface YouTubeIframeApi {
  Player: new (target: HTMLIFrameElement, options: YouTubePlayerOptions) => YouTubePlayerApi;
}

interface YouTubePlayerOptions {
  events: {
    onReady: () => void;
    onStateChange: (event: YouTubePlayerEvent<number>) => void;
    onPlaybackRateChange: (event: YouTubePlayerEvent<number>) => void;
    onAutoplayBlocked: () => void;
    onError: (event: YouTubePlayerEvent<number>) => void;
  };
}

interface YouTubePlayerEvent<Data> {
  data: Data;
}

export interface YouTubePlayerApi {
  playVideo(): void;
  pauseVideo(): void;
  cueVideoById(id: string): void;
  loadVideoById(id: string): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getVolume(): number;
  setVolume(volume: number): void;
  isMuted(): boolean;
  mute(): void;
  unMute(): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getPlayerState(): number;
  destroy(): void;
}

declare global {
  var YT: YouTubeIframeApi | undefined;
  var onYouTubeIframeAPIReady: (() => void) | undefined;
}

interface PublicPromise<T> extends Promise<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createPublicPromise<T>(): PublicPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as PublicPromise<T>;
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}
