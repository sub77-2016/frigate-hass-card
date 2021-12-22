import { CSSResultGroup, LitElement, TemplateResult, html, unsafeCSS } from 'lit';
import { BrowseMediaUtil } from '../browse-media-util.js';
import { EmblaOptionsType } from 'embla-carousel';
import { HomeAssistant } from 'custom-card-helpers';
import { createRef, Ref, ref } from 'lit/directives/ref.js';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { until } from 'lit/directives/until.js';

import type {
  BrowseMediaNeighbors,
  BrowseMediaQueryParameters,
  BrowseMediaSource,
  ExtendedHomeAssistant,
  MediaShowInfo,
  ViewerConfig,
} from '../types.js';
import { FrigateCardMediaCarousel, IMG_EMPTY } from './media-carousel.js';
import { FrigateCardNextPreviousControl } from './next-prev-control.js';
import { FrigateCardThumbnailCarousel, ThumbnailCarouselTap } from './thumbnail-carousel.js';
import { ResolvedMediaCache, ResolvedMediaUtil } from '../resolved-media.js';
import { View } from '../view.js';
import { actionHandler } from '../action-handler-directive.js';
import {
  createMediaShowInfo,
  dispatchErrorMessageEvent,
  dispatchMessageEvent,
  dispatchPauseEvent,
  dispatchPlayEvent,
} from '../common.js';
import { localize } from '../localize/localize.js';
import { renderProgressIndicator } from '../components/message.js';

import './next-prev-control.js';

import viewerStyle from '../scss/viewer.scss';
import viewerCoreStyle from '../scss/viewer-core.scss';

@customElement('frigate-card-viewer')
export class FrigateCardViewer extends LitElement {
  @property({ attribute: false })
  protected hass?: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected view?: View;

  @property({ attribute: false })
  protected viewerConfig?: ViewerConfig;

  @property({ attribute: false })
  protected browseMediaQueryParameters?: BrowseMediaQueryParameters;

  @property({ attribute: false })
  protected resolvedMediaCache?: ResolvedMediaCache;

  /**
   * Resolve all the given media for a target.
   * @param target The target to resolve media from.
   * @returns True if the resolutions were all error free.
   */
  protected async _resolveAllMediaForTarget(
    target: BrowseMediaSource,
  ): Promise<boolean> {
    if (!this.hass) {
      return false;
    }

    let errorFree = true;
    for (let i = 0; target.children && i < (target.children || []).length; ++i) {
      if (BrowseMediaUtil.isTrueMedia(target.children[i])) {
        errorFree &&= !!(await ResolvedMediaUtil.resolveMedia(
          this.hass,
          target.children[i],
          this.resolvedMediaCache,
        ));
      }
    }
    return errorFree;
  }

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    return html`${until(this._render(), renderProgressIndicator())}`;
  }

  /**
   * Asyncronously render the element.
   * @returns A rendered template.
   */
  protected async _render(): Promise<TemplateResult | void> {
    if (!this.hass || !this.view || !this.browseMediaQueryParameters) {
      return html``;
    }

    if (this.view.is('clip') || this.view.is('snapshot')) {
      let parent: BrowseMediaSource | null = null;
      try {
        parent = await BrowseMediaUtil.browseMediaQuery(
          this.hass,
          this.browseMediaQueryParameters,
        );
      } catch (e) {
        return dispatchErrorMessageEvent(this, (e as Error).message);
      }
      const childIndex = BrowseMediaUtil.getFirstTrueMediaChildIndex(parent);
      if (!parent || !parent.children || childIndex == null) {
        return dispatchMessageEvent(
          this,
          this.view.is('clip')
            ? localize('common.no_clip')
            : localize('common.no_snapshot'),
          this.view.is('clip') ? 'mdi:filmstrip-off' : 'mdi:camera-off',
        );
      }
      this.view.target = parent;
      this.view.childIndex = childIndex;
    }

    if (this.view.target && !(await this._resolveAllMediaForTarget(this.view.target))) {
      return dispatchErrorMessageEvent(this, localize('error.could_not_resolve'));
    }

    return html` <frigate-card-viewer-core
      .view=${this.view}
      .viewerConfig=${this.viewerConfig}
      .resolvedMediaCache=${this.resolvedMediaCache}
      .hass=${this.hass}
      .browseMediaQueryParameters=${this.browseMediaQueryParameters}
    >
    </frigate-card-viewer-core>`;
  }

  /**
   * Get element styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(viewerStyle);
  }
}

@customElement('frigate-card-viewer-core')
export class FrigateCardViewerCore extends LitElement {
  @property({ attribute: false })
  protected hass?: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected view?: View;

  @property({ attribute: false })
  protected viewerConfig?: ViewerConfig;

  @property({ attribute: false })
  protected browseMediaQueryParameters?: BrowseMediaQueryParameters;

  @property({ attribute: false })
  protected resolvedMediaCache?: ResolvedMediaCache;

  protected _viewerCarouselRef: Ref<FrigateCardViewerCarousel> = createRef();
  protected _thumbnailCarouselRef: Ref<FrigateCardThumbnailCarousel> = createRef();

  protected _syncThumbnailCarousel(): void {
    const mediaSelected = this._viewerCarouselRef.value?.carouselSelected();
    if (mediaSelected !== undefined) {
      this._thumbnailCarouselRef.value?.carouselScrollTo(mediaSelected);
    }
  }

  protected _renderThumbnails(): TemplateResult {
    if (!this.view || !this.viewerConfig) {
      return html``;
    }

    return html` <frigate-card-thumbnail-carousel
      ${ref(this._thumbnailCarouselRef)}
      .target=${this.view.target}
      .config=${this.viewerConfig.controls.thumbnails}
      @frigate-card:carousel:tap=${(ev: CustomEvent<ThumbnailCarouselTap>) => {
        this._viewerCarouselRef.value?.carouselScrollTo(ev.detail.slideIndex);
      }}
      @frigate-card:carousel:init=${this._syncThumbnailCarousel.bind(this)}
    >
    </frigate-card-thumbnail-carousel>`;
  }

  protected render(): TemplateResult | void {
    if (!this.view || !this.viewerConfig) {
      return html``;
    }
    return html` ${this.viewerConfig &&
      this.viewerConfig.controls.thumbnails.mode === 'above'
        ? this._renderThumbnails()
        : ''}
      <frigate-card-viewer-carousel
        ${ref(this._viewerCarouselRef)}
        .hass=${this.hass}
        .view=${this.view}
        .viewerConfig=${this.viewerConfig}
        .browseMediaQueryParameters=${this.browseMediaQueryParameters}
        .resolvedMediaCache=${this.resolvedMediaCache}
        @frigate-card:carousel:select=${this._syncThumbnailCarousel.bind(this)}
      >
      </frigate-card-viewer-carousel>
      ${this.viewerConfig && this.viewerConfig.controls.thumbnails.mode === 'below'
        ? this._renderThumbnails()
        : ''}`;
  }

  /**
   * Get element styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(viewerCoreStyle);
  }
}

@customElement('frigate-card-viewer-carousel')
export class FrigateCardViewerCarousel extends FrigateCardMediaCarousel {
  @property({ attribute: false })
  protected hass?: HomeAssistant & ExtendedHomeAssistant;

  @property({ attribute: false })
  protected view?: View;

  @property({ attribute: false })
  protected viewerConfig?: ViewerConfig;

  @property({ attribute: false })
  protected browseMediaQueryParameters?: BrowseMediaQueryParameters;

  @property({ attribute: false })
  protected resolvedMediaCache?: ResolvedMediaCache;

  // Mapping of slide # to BrowseMediaSource child #.
  // (Folders are not media items that can be rendered).
  protected _slideToChild: Record<number, number> = {};

  /**
   * Get the Embla options to use.
   * @returns An EmblaOptionsType object or undefined for no options.
   */
   protected _getOptions(): EmblaOptionsType {
    // Start the carousel on the selected child number.
    const startIndex = Number(
      Object.keys(this._slideToChild).find(
        (key) => this._slideToChild[key] === this.view?.childIndex,
      ),
    );

    return {
      startIndex: isNaN(startIndex) ? undefined : startIndex,
      draggable: this.viewerConfig?.draggable,
    };
  }

  /**
   * Get the previous and next true media items from the current view.
   * @returns A BrowseMediaNeighbors with indices and objects of true media
   * neighbors.
   */
  protected _getMediaNeighbors(): BrowseMediaNeighbors | null {
    if (
      !this.view ||
      !this.view.target ||
      !this.view.target.children ||
      this.view.childIndex === undefined
    ) {
      return null;
    }

    // Work backwards from the index to get the previous real media.
    let prevIndex: number | null = null;
    for (let i = this.view.childIndex - 1; i >= 0; i--) {
      const media = this.view.target.children[i];
      if (media && BrowseMediaUtil.isTrueMedia(media)) {
        prevIndex = i;
        break;
      }
    }

    // Work forwards from the index to get the next real media.
    let nextIndex: number | null = null;
    for (let i = this.view.childIndex + 1; i < this.view.target.children.length; i++) {
      const media = this.view.target.children[i];
      if (media && BrowseMediaUtil.isTrueMedia(media)) {
        nextIndex = i;
        break;
      }
    }

    return {
      previousIndex: prevIndex,
      previous: prevIndex != null ? this.view.target.children[prevIndex] : null,
      nextIndex: nextIndex,
      next: nextIndex != null ? this.view.target.children[nextIndex] : null,
    };
  }

  /**
   * Get a clip view that matches a given snapshot. Includes clips within the
   * same range as the current view.
   * @param snapshot The snapshot to find a matching clip for.
   * @returns The view that would show the matching clip.
   */
  protected async _findRelatedClipView(
    snapshot: BrowseMediaSource,
  ): Promise<View | null> {
    if (
      !this.hass ||
      !this.view ||
      !this.view.target ||
      !this.view.target.children ||
      !this.view.target.children.length ||
      !this.browseMediaQueryParameters
    ) {
      return null;
    }

    const snapshotStartTime = BrowseMediaUtil.extractEventStartTime(snapshot);
    if (!snapshotStartTime) {
      return null;
    }

    // Heuristic: At this point, the user has a particular snapshot that they
    // are interested in and want to see a related clip, yet the viewer code
    // does not know the exact search criteria that led to that snapshot (e.g.
    // it could be a 10-deep folder in the gallery). To give the user to ability
    // to 'navigate' in the clips view once they change into that mode, this
    // heuristic finds the earliest and latest snapshot that the user is
    // currently viewing and mirrors that range into the clips view. Then,
    // within the results see if there's a clip that matches the same time as
    // the snapshot.
    let earliest: number | null = null;
    let latest: number | null = null;
    for (let i = 0; i < this.view.target.children.length; i++) {
      const child = this.view.target.children[i];
      if (!BrowseMediaUtil.isTrueMedia(child)) {
        continue;
      }
      const startTime = BrowseMediaUtil.extractEventStartTime(child);

      if (startTime && (earliest === null || startTime < earliest)) {
        earliest = startTime;
      }
      if (startTime && (latest === null || startTime > latest)) {
        latest = startTime;
      }
    }
    if (!earliest || !latest) {
      return null;
    }

    let clips: BrowseMediaSource | null;

    try {
      clips = await BrowseMediaUtil.browseMediaQuery(this.hass, {
        ...this.browseMediaQueryParameters,
        mediaType: 'clips',
        before: latest,
        after: earliest,
      });
    } catch (e) {
      // This is best effort.
      return null;
    }

    if (!clips || !clips.children || !clips.children.length) {
      return null;
    }

    for (let i = 0; i < clips.children.length; i++) {
      const child = clips.children[i];
      if (!BrowseMediaUtil.isTrueMedia(child)) {
        continue;
      }
      const clipStartTime = BrowseMediaUtil.extractEventStartTime(child);
      if (clipStartTime && clipStartTime === snapshotStartTime) {
        return new View({
          view: 'clip-specific',
          camera: this.view.camera,
          target: clips,
          childIndex: i,
          previous: this.view,
        });
      }
    }
    return null;
  }

  /**
   * Handle the user selecting a new slide in the carousel.
   */
  protected _selectSlideSetViewHandler(): void {
    if (!this._carousel || !this.view) {
      return;
    }

    // Update the childIndex in the view.
    const slidesInView = this._carousel.slidesInView(true);
    if (slidesInView.length) {
      const childIndex = this._slideToChild[slidesInView[0]];
      if (childIndex !== undefined) {
        // Update the currently live view in place.
        this.view.childIndex = childIndex;
      }
    }
  }

    /**
   * Lazy load a slide.
   * @param slide The slide to lazy load.
   */
  protected _lazyLoadSlide(slide: HTMLElement): void {

    // Snapshots.
    const img = slide.querySelector('img') as HTMLImageElement;

    // Frigate >= 0.9.0+ clips.
    const hls_player = slide.querySelector(
      'frigate-card-ha-hls-player',
    ) as HTMLElement & { url: string };

    // Frigate < 0.9.0 clips. frigate-card-ha-hls-player will also have a
    // video source element, so search for that first.
    const video_source = slide.querySelector('video source') as HTMLElement & {
      src: string;
    };

    if (img) {
      img.src = img.getAttribute('data-src') || img.src;
    } else if (hls_player) {
      hls_player.url = hls_player.getAttribute('data-url') || hls_player.url;
    } else if (video_source) {
      video_source.src = video_source.getAttribute('data-src') || video_source.src;
    }
  }

  /**
   * Handle updating of the next/previous controls when the carousel is moved.
   */
  protected _selectSlideNextPreviousHandler(): void {
    const updateNextPreviousControl = (control: FrigateCardNextPreviousControl, direction: 'previous' | 'next'): void => {
      const neighbors = this._getMediaNeighbors();
      const [prev, next] = [neighbors?.previous, neighbors?.next]
      const target = direction == 'previous' ? prev : next;
  
      control.disabled = (target == null)
      control.title = (target && target.title ? target.title : '')
      control.thumbnail = (target && target.thumbnail ? target.thumbnail : undefined)
    }

    if (this._previousControlRef.value) {
      updateNextPreviousControl(this._previousControlRef.value, 'previous');
    }
    if (this._nextControlRef.value) {
      updateNextPreviousControl(this._nextControlRef.value, 'next');
    }
  }

  /**
   * Get slides to include in the render.
   * @returns The slides to include in the render.
   */
  protected _getSlides(): TemplateResult[] {
    if (
      !this.view ||
      !this.view.target ||
      !this.view.target.children ||
      !this.view.target.children.length
    ) {
      return [];
    }

    this._slideToChild = {};
    const slides: TemplateResult[] = [];
    for (let i = 0; i < this.view.target.children?.length; ++i) {
      const slide = this._renderMediaItem(this.view.target.children[i], slides.length);

      if (slide) {
        this._slideToChild[slides.length] = i;
        slides.push(slide);
      }
    }
    return slides;
  }

  /**
   * Render the element.
   * @returns A template to display to the user.
   */
  protected render(): TemplateResult | void {
    const slides = this._getSlides();
    if (!slides) {
      return;
    }

    const neighbors = this._getMediaNeighbors();
    const [prev, next] = [neighbors?.previous, neighbors?.next]

    return html`<div class="embla">
      <frigate-card-next-previous-control
        ${ref(this._previousControlRef)}
        .direction=${'previous'}
        .controlConfig=${this.viewerConfig?.controls.next_previous}
        .thumbnail=${prev && prev.thumbnail ? prev.thumbnail : undefined}
        .title=${prev ? prev.title : ''}
        ?disabled=${!prev}
        @click=${() => {
          this._nextPreviousHandler('previous');
        }}
      ></frigate-card-next-previous-control>
      <div class="embla__viewport">
        <div class="embla__container">${slides}</div>
      </div>
      <frigate-card-next-previous-control
        ${ref(this._nextControlRef)}
        .direction=${'next'}
        .controlConfig=${this.viewerConfig?.controls.next_previous}
        .thumbnail=${next && next.thumbnail ? next.thumbnail : undefined}
        .title=${next ? next.title : ''}
        ?disabled=${!next}
        @click=${() => {
          this._nextPreviousHandler('next');
        }}
      ></frigate-card-next-previous-control>
    </div>`;
  }


  protected _renderMediaItem(
    mediaToRender: BrowseMediaSource,
    slideIndex: number,
  ): TemplateResult | void {
    // media that can be expanded (folders) cannot be resolved to a single media
    // item, skip them.
    if (
      !this.view ||
      !this.viewerConfig ||
      !BrowseMediaUtil.isTrueMedia(mediaToRender)
    ) {
      return;
    }

    const resolvedMedia = this.resolvedMediaCache?.get(mediaToRender.media_content_id);
    if (!resolvedMedia) {
      return;
    }

    // In this block, no clip has been manually selected, so this is loading
    // the most recent clip on card load. In this mode, autoplay of the clip
    // may be disabled by configuration. If does not make sense to disable
    // autoplay when the user has explicitly picked an event to play in the
    // gallery.
    let autoplay = true;
    if (this.view.is('clip') || this.view.is('snapshot')) {
      autoplay = this.viewerConfig.autoplay_clip;
    }

    const lazyLoad = this.viewerConfig.lazy_load;

    return html`
      <div class="embla__slide">
        ${this.view.isClipRelatedView()
          ? resolvedMedia?.mime_type.toLowerCase() == 'application/x-mpegurl'
            ? html`<frigate-card-ha-hls-player
                .hass=${this.hass}
                url=${ifDefined(lazyLoad ? undefined : resolvedMedia.url)}
                data-url=${ifDefined(lazyLoad ? resolvedMedia.url : undefined)}
                title="${mediaToRender.title}"
                muted
                controls
                playsinline
                allow-exoplayer
                ?autoplay="${autoplay}"
                @frigate-card:media-show=${(e: CustomEvent<MediaShowInfo>) =>
                  this._mediaShowEventHandler(slideIndex, e)}
              >
              </frigate-card-ha-hls-player>`
            : html`<video
                title="${mediaToRender.title}"
                muted
                controls
                playsinline
                ?autoplay="${autoplay}"
                @loadedmetadata="${(e: Event) => {
                  this._mediaLoadedHandler(slideIndex, createMediaShowInfo(e));
                }}"
                @play=${() => dispatchPlayEvent(this)}
                @pause=${() => dispatchPauseEvent(this)}
              >
                <source
                  src=${ifDefined(lazyLoad ? undefined : resolvedMedia.url)}
                  data-src=${ifDefined(lazyLoad ? resolvedMedia.url : undefined)}
                  type="${resolvedMedia.mime_type}"
                />
              </video>`
          : html`<img
              src=${ifDefined(lazyLoad ? IMG_EMPTY : resolvedMedia.url)}
              data-src=${ifDefined(lazyLoad ? resolvedMedia.url : undefined)}
              title="${mediaToRender.title}"
              .actionHandler=${actionHandler({
                hasHold: false,
                hasDoubleClick: false,
              })}
              @action=${() => {
                if (this._carousel?.clickAllowed()) {
                  this._findRelatedClipView(mediaToRender).then((view) => {
                    if (view) {
                      view.dispatchChangeEvent(this);
                    }
                  });
                }
              }}
              @load="${(e: Event) => {
                if (
                  this.viewerConfig &&
                  (!this.viewerConfig.lazy_load ||
                    this._slideHasBeenLazyLoaded[slideIndex])
                ) {
                  this._mediaLoadedHandler(slideIndex, createMediaShowInfo(e));
                }
              }}"
            />`}
      </div>
    `;
  }
}
