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
  },
  setup(props) {
    return () => h('div', {
      id: 'agent-sprite',
      class: 'voice-sprite',
      'data-state': props.state,
      'aria-label': `Agent ${props.state}`,
      role: 'img',
    }, [h('img', {
      class: 'sprite-image',
      src: props.source,
      alt: '',
      draggable: false,
      style: { animationName: props.animations[props.state] || defaultAnimations.idle },
    })]);
  },
};