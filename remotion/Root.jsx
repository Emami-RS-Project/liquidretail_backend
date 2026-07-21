// Composition registry. All three canonical formats render the same spec
// interpreter; fps/duration come from inputProps at render time (probed
// from the actual plate video by remotionRenderService — never assumed).

import React from 'react';
import { Composition } from 'remotion';
import { Canonical } from './compositions/Canonical.jsx';

const FALLBACK = { fps: 24, durationInFrames: 192 }; // 8s nominal

const calculateMetadata = ({ props }) => ({
  fps: props.fps || FALLBACK.fps,
  durationInFrames: props.durationInFrames || FALLBACK.durationInFrames,
  props,
});

const DEFAULTS = {
  plate: { color: '#3D3D3D' },
  meta: {},
  tokens: {},
  spec: null,
  fps: FALLBACK.fps,
  durationInFrames: FALLBACK.durationInFrames,
  debugLayout: false,
};

export const RemotionRoot = () => (
  <>
    <Composition
      id="CanonicalVertical"
      component={Canonical}
      width={1080}
      height={1920}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'vertical' }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="CanonicalFeed"
      component={Canonical}
      width={1080}
      height={1350}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'feed' }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="CanonicalLandscape"
      component={Canonical}
      width={1920}
      height={1080}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'landscape' }}
      calculateMetadata={calculateMetadata}
    />
  </>
);
