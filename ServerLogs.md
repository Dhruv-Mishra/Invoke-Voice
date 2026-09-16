PS C:\Users\dhruvmishra\OneDrive - Microsoft\Desktop\VoiceOrchestration\voice-supervisor> npm run local:check
>> npm run local

> voice-work-supervisor@0.1.0 local:check
> node --env-file-if-exists=.env scripts/start-local.mjs --check

0.00.616.141 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)
0.00.616.312 I srv          init: The UI is disabled
0.00.616.313 I srv          init: Use --ui/--no-ui (or deprecated --webui/--no-webui) to enable/disable
0.00.629.471 I srv    load_model: loading model 'C:\Users\dhruvmishra\OneDrive - Microsoft\Desktop\VoiceOrchestration\LocalVoiceStack\LLMs\Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf'
0.04.385.635 W load: special_eos_id is not in special_eog_ids - the tokenizer config may be incorrect
0.04.422.974 W llama_model_loader: tensor overrides to CPU are used with mmap enabled - consider using --load-mode none for better performance
0.06.294.678 I cmn          init: llama threadpool init, n_threads = 12
0.07.967.134 I srv    load_model: initializing, n_slots = 2, n_ctx_slot = 4096, kv_unified = 'false'
0.07.987.555 I srv          init: chat template supports preserving reasoning, consider enabling it via --reasoning-preserve
0.07.987.588 I srv  llama_server: model loaded
0.07.987.592 I srv  llama_server: listening on http://127.0.0.1:8081
0.09.014.523 I slot get_availabl: id  1 | task -1 | selected slot by LRU, t_last = -1
0.09.014.624 I slot launch_slot_: id  1 | task 0 | processing task, is_child = 0
0.12.507.823 I slot print_timing: id  1 | task 0 | prompt eval time =    2925.03 ms /    27 tokens (  108.33 ms per token,     9.23 tokens per second)
0.12.507.832 I slot print_timing: id  1 | task 0 |        eval time =     568.09 ms /     2 tokens (  568.09 ms per token,     1.76 tokens per second)
0.12.507.834 I slot print_timing: id  1 | task 0 |       total time =    3493.11 ms /    29 tokens
0.12.507.835 I slot print_timing: id  1 | task 0 |    graphs reused =          1
0.12.507.864 I slot      release: id  1 | task 0 | stop processing: n_tokens = 28, truncated = 0
Local Ling check: READY

> voice-work-supervisor@0.1.0 local
> node --env-file-if-exists=.env scripts/start-local.mjs

0.00.200.733 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)
0.00.200.862 I srv          init: The UI is disabled
0.00.200.863 I srv          init: Use --ui/--no-ui (or deprecated --webui/--no-webui) to enable/disable
0.00.214.602 I srv    load_model: loading model 'C:\Users\dhruvmishra\OneDrive - Microsoft\Desktop\VoiceOrchestration\LocalVoiceStack\LLMs\Ling-3.0-tiny-abliterated-APEX-I-Compact.gguf'
0.04.267.494 W load: special_eos_id is not in special_eog_ids - the tokenizer config may be incorrect
0.04.331.387 W llama_model_loader: tensor overrides to CPU are used with mmap enabled - consider using --load-mode none for better performance
0.06.197.641 I cmn          init: llama threadpool init, n_threads = 12
0.06.554.160 I srv    load_model: initializing, n_slots = 2, n_ctx_slot = 4096, kv_unified = 'false'
0.06.578.556 I srv          init: chat template supports preserving reasoning, consider enabling it via --reasoning-preserve
0.06.578.596 I srv  llama_server: model loaded
0.06.578.601 I srv  llama_server: listening on http://127.0.0.1:8081
0.07.106.626 I slot get_availabl: id  1 | task -1 | selected slot by LRU, t_last = -1
0.07.106.710 I slot launch_slot_: id  1 | task 0 | processing task, is_child = 0
0.08.365.064 I slot print_timing: id  1 | task 0 | prompt eval time =    1258.30 ms /    71 tokens (   17.72 ms per token,    56.43 tokens per second)
0.08.365.076 I slot print_timing: id  1 | task 0 |        eval time =       0.00 ms /     1 tokens (    0.00 ms per token,     0.00 tokens per second)
0.08.365.077 I slot print_timing: id  1 | task 0 |       total time =    1258.30 ms /    72 tokens
0.08.365.079 I slot print_timing: id  1 | task 0 |    graphs reused =          1
0.08.365.148 I slot      release: id  1 | task 0 | stop processing: n_tokens = 71, truncated = 0
Fast voice LLM lane is warm.
Voice Work Supervisor: http://127.0.0.1:4317
Local speech models are warm.
2.12.560.634 I slot get_availabl: id  1 | task -1 | selected slot by LCP similarity, f_sim_best = 0.843 (> 0.100 thold), f_keep = 0.831
2.12.560.901 I slot launch_slot_: id  1 | task 4 | processing task, is_child = 0
2.13.223.837 I slot print_timing: id  1 | task 4 | prompt eval time =     480.07 ms /    15 tokens (   32.00 ms per token,    31.25 tokens per second)
2.13.223.844 I slot print_timing: id  1 | task 4 |        eval time =     182.81 ms /     7 tokens (   30.47 ms per token,    32.82 tokens per second)
2.13.223.846 I slot print_timing: id  1 | task 4 |       total time =     662.89 ms /    22 tokens
2.13.223.847 I slot print_timing: id  1 | task 4 |    graphs reused =          6
2.13.223.866 I slot      release: id  1 | task 4 | stop processing: n_tokens = 76, truncated = 0
2.14.433.969 I slot get_availabl: id  1 | task -1 | selected slot by LCP similarity, f_sim_best = 0.787 (> 0.100 thold), f_keep = 0.921
2.14.434.248 I slot launch_slot_: id  1 | task 13 | processing task, is_child = 0
2.14.928.637 I slot print_timing: id  1 | task 13 | prompt eval time =     406.02 ms /    23 tokens (   17.65 ms per token,    56.65 tokens per second)
2.14.928.646 I slot print_timing: id  1 | task 13 |        eval time =      88.33 ms /     4 tokens (   29.44 ms per token,    33.97 tokens per second)
2.14.928.647 I slot print_timing: id  1 | task 13 |       total time =     494.34 ms /    27 tokens
2.14.928.648 I slot print_timing: id  1 | task 13 |    graphs reused =          8
2.14.928.679 I slot      release: id  1 | task 13 | stop processing: n_tokens = 92, truncated = 0
2.31.309.871 I slot get_availabl: id  1 | task -1 | selected slot by LCP similarity, f_sim_best = 0.538 (> 0.100 thold), f_keep = 0.609
2.31.310.038 I slot launch_slot_: id  1 | task 20 | processing task, is_child = 0
2.32.421.570 I slot print_timing: id  1 | task 20 | prompt eval time =     824.69 ms /    49 tokens (   16.83 ms per token,    59.42 tokens per second)
2.32.421.579 I slot print_timing: id  1 | task 20 |        eval time =     286.80 ms /    11 tokens (   28.68 ms per token,    34.87 tokens per second)
2.32.421.581 I slot print_timing: id  1 | task 20 |       total time =    1111.49 ms /    60 tokens
2.32.421.582 I slot print_timing: id  1 | task 20 |    graphs reused =         17
2.32.421.613 I slot      release: id  1 | task 20 | stop processing: n_tokens = 114, truncated = 0
2.47.203.104 I slot get_availabl: id  1 | task -1 | selected slot by LCP similarity, f_sim_best = 0.640 (> 0.100 thold), f_keep = 0.623
2.47.203.269 I slot launch_slot_: id  1 | task 34 | processing task, is_child = 0
2.48.476.724 I slot print_timing: id  1 | task 34 | prompt eval time =    1067.73 ms /    56 tokens (   19.07 ms per token,    52.45 tokens per second)
2.48.476.731 I slot print_timing: id  1 | task 34 |        eval time =     205.68 ms /     8 tokens (   29.38 ms per token,    34.03 tokens per second)
2.48.476.732 I slot print_timing: id  1 | task 34 |       total time =    1273.41 ms /    64 tokens
2.48.476.733 I slot print_timing: id  1 | task 34 |    graphs reused =         23
2.48.476.760 I slot      release: id  1 | task 34 | stop processing: n_tokens = 118, truncated = 0
3.22.475.467 I slot get_availabl: id  1 | task -1 | selected slot by LCP similarity, f_sim_best = 0.571 (> 0.100 thold), f_keep = 0.542
3.22.475.647 I slot launch_slot_: id  1 | task 45 | processing task, is_child = 0
3.23.930.981 I slot print_timing: id  1 | task 45 | prompt eval time =    1166.06 ms /    57 tokens (   20.46 ms per token,    48.88 tokens per second)
3.23.930.989 I slot print_timing: id  1 | task 45 |        eval time =     289.22 ms /    11 tokens (   28.92 ms per token,    34.58 tokens per second)
3.23.930.991 I slot print_timing: id  1 | task 45 |       total time =    1455.28 ms /    68 tokens
3.23.930.992 I slot print_timing: id  1 | task 45 |    graphs reused =         32
3.23.931.022 I slot      release: id  1 | task 45 | stop processing: n_tokens = 122, truncated = 0
3.44.309.855 I srv    operator(): operator(): cleaning up before exit...
PS C:\Users\dhruvmishra\OneDrive - Microsoft\Desktop\VoiceOrchestration\voice-supervisor> 