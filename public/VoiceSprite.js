import { h } from 'vue';

export const defaultAnimations = Object.freeze({
  idle: 'sprite-float',
  connecting: 'sprite-connect',
  listening: 'sprite-listen',
  thinking: 'sprite-think',
  speaking: 'sprite-speak',
});

export default {
  name: 'VoiceSprite',
  props: {
    state: { type: String, default: 'idle' },
    source: { type: String, required: true },
    animations: { type: Object, default: () => defaultAnimations },
    kind: { type: String, default: 'copilot' },
    variant: { type: String, default: 'default' },
  },
  setup(props) {
    return () => h('div', {
      id: 'agent-sprite',
      class: 'voice-sprite',
      'data-state': props.state,
      'data-kind': props.kind,
      'data-variant': props.variant,
      'aria-label': `Agent ${props.state}`,
      role: 'img',
    }, props.kind === 'companion' ? [h('div', {
      class: 'companion-sprite',
      style: { animationName: props.animations[props.state] || defaultAnimations.idle },
    }, [
      h('div', { class: 'companion-head' }, [
        h('img', { class: 'sprite-image', src: props.source, alt: '', draggable: false }),
        h('span', { class: 'companion-eyes', 'aria-hidden': 'true' }, [h('span'), h('span')]),
      ]),
    ])] : [h('img', {
      class: 'sprite-image',
      src: props.source,
      alt: '',
      draggable: false,
      style: { animationName: props.animations[props.state] || defaultAnimations.idle },
    }), ...(props.kind === 'reactor' ? [h('span', { class: 'reactor-orbit', 'aria-hidden': 'true' })] : [])]);
  },
};