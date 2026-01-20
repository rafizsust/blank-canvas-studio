export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_practice_results: {
        Row: {
          answers: Json
          band_score: number | null
          completed_at: string
          created_at: string
          evaluation_timing: Json | null
          id: string
          module: string
          question_results: Json
          score: number
          test_id: string
          time_spent_seconds: number
          total_questions: number
          user_id: string
        }
        Insert: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          evaluation_timing?: Json | null
          id?: string
          module: string
          question_results?: Json
          score?: number
          test_id: string
          time_spent_seconds?: number
          total_questions?: number
          user_id: string
        }
        Update: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          evaluation_timing?: Json | null
          id?: string
          module?: string
          question_results?: Json
          score?: number
          test_id?: string
          time_spent_seconds?: number
          total_questions?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_practice_results_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "ai_practice_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_practice_tests: {
        Row: {
          audio_format: string | null
          audio_url: string | null
          difficulty: string
          generated_at: string
          id: string
          is_preset: boolean | null
          module: string
          payload: Json
          preset_id: string | null
          question_type: string
          sample_rate: number | null
          time_minutes: number
          topic: string
          total_questions: number
          user_id: string
        }
        Insert: {
          audio_format?: string | null
          audio_url?: string | null
          difficulty: string
          generated_at?: string
          id?: string
          is_preset?: boolean | null
          module: string
          payload?: Json
          preset_id?: string | null
          question_type: string
          sample_rate?: number | null
          time_minutes: number
          topic: string
          total_questions: number
          user_id: string
        }
        Update: {
          audio_format?: string | null
          audio_url?: string | null
          difficulty?: string
          generated_at?: string
          id?: string
          is_preset?: boolean | null
          module?: string
          payload?: Json
          preset_id?: string | null
          question_type?: string
          sample_rate?: number | null
          time_minutes?: number
          topic?: string
          total_questions?: number
          user_id?: string
        }
        Relationships: []
      }
      ai_practice_topic_completions: {
        Row: {
          completed_count: number
          created_at: string
          id: string
          module: string
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_count?: number
          created_at?: string
          id?: string
          module: string
          topic: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_count?: number
          created_at?: string
          id?: string
          module?: string
          topic?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      api_key_locks: {
        Row: {
          cooldown_until: string | null
          created_at: string | null
          id: string
          job_id: string
          key_id: string | null
          locked_at: string | null
          part_number: number
          release_at: string
          released_at: string | null
        }
        Insert: {
          cooldown_until?: string | null
          created_at?: string | null
          id?: string
          job_id: string
          key_id?: string | null
          locked_at?: string | null
          part_number: number
          release_at: string
          released_at?: string | null
        }
        Update: {
          cooldown_until?: string | null
          created_at?: string | null
          id?: string
          job_id?: string
          key_id?: string | null
          locked_at?: string | null
          part_number?: number
          release_at?: string
          released_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_key_locks_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          consecutive_429_count: number | null
          created_at: string
          error_count: number
          exp_pro_quota_exhausted: boolean | null
          exp_pro_quota_exhausted_date: string | null
          flash_2_5_quota_exhausted: boolean | null
          flash_2_5_quota_exhausted_date: string | null
          flash_lite_quota_exhausted: boolean | null
          flash_lite_quota_exhausted_date: string | null
          gemini_2_0_flash_exhausted: boolean | null
          gemini_2_0_flash_exhausted_date: string | null
          gemini_2_0_flash_lite_exhausted: boolean | null
          gemini_2_0_flash_lite_exhausted_date: string | null
          gemini_2_5_flash_exhausted: boolean | null
          gemini_2_5_flash_exhausted_date: string | null
          gemini_2_5_flash_tts_exhausted: boolean | null
          gemini_2_5_flash_tts_exhausted_date: string | null
          gemini_2_5_pro_exhausted: boolean | null
          gemini_2_5_pro_exhausted_date: string | null
          gemini_3_pro_exhausted: boolean | null
          gemini_3_pro_exhausted_date: string | null
          gemini_exp_1206_exhausted: boolean | null
          gemini_exp_1206_exhausted_date: string | null
          groq_ash_reset_at: string | null
          groq_ash_used_this_hour: number | null
          groq_llama_70b_exhausted: boolean | null
          groq_llama_70b_exhausted_date: string | null
          groq_llama_exhausted: boolean | null
          groq_llama_exhausted_date: string | null
          groq_llm_requests_minute_start: string | null
          groq_llm_requests_this_minute: number | null
          groq_rpm_cooldown_until: string | null
          groq_stt_requests_minute_start: string | null
          groq_stt_requests_this_minute: number | null
          groq_whisper_exhausted: boolean | null
          groq_whisper_exhausted_date: string | null
          groq_whisper_v3_turbo_exhausted: boolean | null
          groq_whisper_v3_turbo_exhausted_date: string | null
          id: string
          is_active: boolean
          key_value: string
          last_429_at: string | null
          locked_by_job_id: string | null
          locked_until: string | null
          pro_3_0_quota_exhausted: boolean | null
          pro_3_0_quota_exhausted_date: string | null
          provider: string
          rate_limited_until: string | null
          tts_quota_exhausted: boolean | null
          tts_quota_exhausted_date: string | null
          updated_at: string
        }
        Insert: {
          consecutive_429_count?: number | null
          created_at?: string
          error_count?: number
          exp_pro_quota_exhausted?: boolean | null
          exp_pro_quota_exhausted_date?: string | null
          flash_2_5_quota_exhausted?: boolean | null
          flash_2_5_quota_exhausted_date?: string | null
          flash_lite_quota_exhausted?: boolean | null
          flash_lite_quota_exhausted_date?: string | null
          gemini_2_0_flash_exhausted?: boolean | null
          gemini_2_0_flash_exhausted_date?: string | null
          gemini_2_0_flash_lite_exhausted?: boolean | null
          gemini_2_0_flash_lite_exhausted_date?: string | null
          gemini_2_5_flash_exhausted?: boolean | null
          gemini_2_5_flash_exhausted_date?: string | null
          gemini_2_5_flash_tts_exhausted?: boolean | null
          gemini_2_5_flash_tts_exhausted_date?: string | null
          gemini_2_5_pro_exhausted?: boolean | null
          gemini_2_5_pro_exhausted_date?: string | null
          gemini_3_pro_exhausted?: boolean | null
          gemini_3_pro_exhausted_date?: string | null
          gemini_exp_1206_exhausted?: boolean | null
          gemini_exp_1206_exhausted_date?: string | null
          groq_ash_reset_at?: string | null
          groq_ash_used_this_hour?: number | null
          groq_llama_70b_exhausted?: boolean | null
          groq_llama_70b_exhausted_date?: string | null
          groq_llama_exhausted?: boolean | null
          groq_llama_exhausted_date?: string | null
          groq_llm_requests_minute_start?: string | null
          groq_llm_requests_this_minute?: number | null
          groq_rpm_cooldown_until?: string | null
          groq_stt_requests_minute_start?: string | null
          groq_stt_requests_this_minute?: number | null
          groq_whisper_exhausted?: boolean | null
          groq_whisper_exhausted_date?: string | null
          groq_whisper_v3_turbo_exhausted?: boolean | null
          groq_whisper_v3_turbo_exhausted_date?: string | null
          id?: string
          is_active?: boolean
          key_value: string
          last_429_at?: string | null
          locked_by_job_id?: string | null
          locked_until?: string | null
          pro_3_0_quota_exhausted?: boolean | null
          pro_3_0_quota_exhausted_date?: string | null
          provider: string
          rate_limited_until?: string | null
          tts_quota_exhausted?: boolean | null
          tts_quota_exhausted_date?: string | null
          updated_at?: string
        }
        Update: {
          consecutive_429_count?: number | null
          created_at?: string
          error_count?: number
          exp_pro_quota_exhausted?: boolean | null
          exp_pro_quota_exhausted_date?: string | null
          flash_2_5_quota_exhausted?: boolean | null
          flash_2_5_quota_exhausted_date?: string | null
          flash_lite_quota_exhausted?: boolean | null
          flash_lite_quota_exhausted_date?: string | null
          gemini_2_0_flash_exhausted?: boolean | null
          gemini_2_0_flash_exhausted_date?: string | null
          gemini_2_0_flash_lite_exhausted?: boolean | null
          gemini_2_0_flash_lite_exhausted_date?: string | null
          gemini_2_5_flash_exhausted?: boolean | null
          gemini_2_5_flash_exhausted_date?: string | null
          gemini_2_5_flash_tts_exhausted?: boolean | null
          gemini_2_5_flash_tts_exhausted_date?: string | null
          gemini_2_5_pro_exhausted?: boolean | null
          gemini_2_5_pro_exhausted_date?: string | null
          gemini_3_pro_exhausted?: boolean | null
          gemini_3_pro_exhausted_date?: string | null
          gemini_exp_1206_exhausted?: boolean | null
          gemini_exp_1206_exhausted_date?: string | null
          groq_ash_reset_at?: string | null
          groq_ash_used_this_hour?: number | null
          groq_llama_70b_exhausted?: boolean | null
          groq_llama_70b_exhausted_date?: string | null
          groq_llama_exhausted?: boolean | null
          groq_llama_exhausted_date?: string | null
          groq_llm_requests_minute_start?: string | null
          groq_llm_requests_this_minute?: number | null
          groq_rpm_cooldown_until?: string | null
          groq_stt_requests_minute_start?: string | null
          groq_stt_requests_this_minute?: number | null
          groq_whisper_exhausted?: boolean | null
          groq_whisper_exhausted_date?: string | null
          groq_whisper_v3_turbo_exhausted?: boolean | null
          groq_whisper_v3_turbo_exhausted_date?: string | null
          id?: string
          is_active?: boolean
          key_value?: string
          last_429_at?: string | null
          locked_by_job_id?: string | null
          locked_until?: string | null
          pro_3_0_quota_exhausted?: boolean | null
          pro_3_0_quota_exhausted_date?: string | null
          provider?: string
          rate_limited_until?: string | null
          tts_quota_exhausted?: boolean | null
          tts_quota_exhausted_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      bulk_generation_jobs: {
        Row: {
          admin_user_id: string
          completed_at: string | null
          created_at: string
          difficulty: string
          error_log: Json | null
          failure_count: number
          id: string
          module: string
          monologue: boolean | null
          quantity: number
          question_type: string | null
          started_at: string | null
          status: string
          success_count: number
          topic: string
          updated_at: string
        }
        Insert: {
          admin_user_id: string
          completed_at?: string | null
          created_at?: string
          difficulty: string
          error_log?: Json | null
          failure_count?: number
          id?: string
          module: string
          monologue?: boolean | null
          quantity: number
          question_type?: string | null
          started_at?: string | null
          status?: string
          success_count?: number
          topic: string
          updated_at?: string
        }
        Update: {
          admin_user_id?: string
          completed_at?: string | null
          created_at?: string
          difficulty?: string
          error_log?: Json | null
          failure_count?: number
          id?: string
          module?: string
          monologue?: boolean | null
          quantity?: number
          question_type?: string | null
          started_at?: string | null
          status?: string
          success_count?: number
          topic?: string
          updated_at?: string
        }
        Relationships: []
      }
      flashcard_cards: {
        Row: {
          correct_count: number
          created_at: string
          deck_id: string
          example: string | null
          id: string
          meaning: string
          next_review_at: string | null
          review_count: number
          status: string
          translation: string | null
          updated_at: string
          user_id: string
          word: string
        }
        Insert: {
          correct_count?: number
          created_at?: string
          deck_id: string
          example?: string | null
          id?: string
          meaning: string
          next_review_at?: string | null
          review_count?: number
          status?: string
          translation?: string | null
          updated_at?: string
          user_id: string
          word: string
        }
        Update: {
          correct_count?: number
          created_at?: string
          deck_id?: string
          example?: string | null
          id?: string
          meaning?: string
          next_review_at?: string | null
          review_count?: number
          status?: string
          translation?: string | null
          updated_at?: string
          user_id?: string
          word?: string
        }
        Relationships: [
          {
            foreignKeyName: "flashcard_cards_deck_id_fkey"
            columns: ["deck_id"]
            isOneToOne: false
            referencedRelation: "flashcard_decks"
            referencedColumns: ["id"]
          },
        ]
      }
      flashcard_decks: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      generated_test_audio: {
        Row: {
          accent: string | null
          audio_duration_seconds: number | null
          audio_url: string | null
          content_payload: Json
          created_at: string
          difficulty: string
          id: string
          is_published: boolean
          job_id: string | null
          last_used_at: string | null
          module: string
          question_type: string | null
          sample_audio_url: string | null
          status: string
          times_used: number
          topic: string
          transcript: string | null
          updated_at: string
          voice_id: string | null
        }
        Insert: {
          accent?: string | null
          audio_duration_seconds?: number | null
          audio_url?: string | null
          content_payload?: Json
          created_at?: string
          difficulty: string
          id?: string
          is_published?: boolean
          job_id?: string | null
          last_used_at?: string | null
          module: string
          question_type?: string | null
          sample_audio_url?: string | null
          status?: string
          times_used?: number
          topic: string
          transcript?: string | null
          updated_at?: string
          voice_id?: string | null
        }
        Update: {
          accent?: string | null
          audio_duration_seconds?: number | null
          audio_url?: string | null
          content_payload?: Json
          created_at?: string
          difficulty?: string
          id?: string
          is_published?: boolean
          job_id?: string | null
          last_used_at?: string | null
          module?: string
          question_type?: string | null
          sample_audio_url?: string | null
          status?: string
          times_used?: number
          topic?: string
          transcript?: string | null
          updated_at?: string
          voice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generated_test_audio_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "bulk_generation_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      listening_question_groups: {
        Row: {
          created_at: string | null
          end_question: number
          group_heading: string | null
          group_heading_alignment: string | null
          id: string
          instruction: string | null
          options: Json | null
          question_type: string
          start_question: number
          start_timestamp_seconds: number | null
          test_id: string
        }
        Insert: {
          created_at?: string | null
          end_question: number
          group_heading?: string | null
          group_heading_alignment?: string | null
          id?: string
          instruction?: string | null
          options?: Json | null
          question_type: string
          start_question: number
          start_timestamp_seconds?: number | null
          test_id: string
        }
        Update: {
          created_at?: string | null
          end_question?: number
          group_heading?: string | null
          group_heading_alignment?: string | null
          id?: string
          instruction?: string | null
          options?: Json | null
          question_type?: string
          start_question?: number
          start_timestamp_seconds?: number | null
          test_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listening_question_groups_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "listening_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      listening_questions: {
        Row: {
          correct_answer: string
          created_at: string | null
          group_id: string
          heading: string | null
          id: string
          is_given: boolean
          option_format: string | null
          options: Json | null
          question_number: number
          question_text: string
          table_data: Json | null
        }
        Insert: {
          correct_answer: string
          created_at?: string | null
          group_id: string
          heading?: string | null
          id?: string
          is_given?: boolean
          option_format?: string | null
          options?: Json | null
          question_number: number
          question_text: string
          table_data?: Json | null
        }
        Update: {
          correct_answer?: string
          created_at?: string | null
          group_id?: string
          heading?: string | null
          id?: string
          is_given?: boolean
          option_format?: string | null
          options?: Json | null
          question_number?: number
          question_text?: string
          table_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "listening_questions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "listening_question_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      listening_test_submissions: {
        Row: {
          answers: Json
          band_score: number | null
          completed_at: string
          created_at: string
          id: string
          score: number
          test_id: string
          total_questions: number
          user_id: string
        }
        Insert: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          id?: string
          score?: number
          test_id: string
          total_questions?: number
          user_id: string
        }
        Update: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          id?: string
          score?: number
          test_id?: string
          total_questions?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listening_test_submissions_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "listening_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      listening_tests: {
        Row: {
          audio_url: string | null
          audio_url_part1: string | null
          audio_url_part2: string | null
          audio_url_part3: string | null
          audio_url_part4: string | null
          book_name: string
          created_at: string | null
          id: string
          is_published: boolean
          test_number: number
          test_type: string
          time_limit: number
          title: string
          total_questions: number
          transcript_part1: string | null
          transcript_part2: string | null
          transcript_part3: string | null
          transcript_part4: string | null
          updated_at: string | null
        }
        Insert: {
          audio_url?: string | null
          audio_url_part1?: string | null
          audio_url_part2?: string | null
          audio_url_part3?: string | null
          audio_url_part4?: string | null
          book_name: string
          created_at?: string | null
          id?: string
          is_published?: boolean
          test_number: number
          test_type?: string
          time_limit?: number
          title: string
          total_questions?: number
          transcript_part1?: string | null
          transcript_part2?: string | null
          transcript_part3?: string | null
          transcript_part4?: string | null
          updated_at?: string | null
        }
        Update: {
          audio_url?: string | null
          audio_url_part1?: string | null
          audio_url_part2?: string | null
          audio_url_part3?: string | null
          audio_url_part4?: string | null
          book_name?: string
          created_at?: string | null
          id?: string
          is_published?: boolean
          test_number?: number
          test_type?: string
          time_limit?: number
          title?: string
          total_questions?: number
          transcript_part1?: string | null
          transcript_part2?: string | null
          transcript_part3?: string | null
          transcript_part4?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      model_performance_logs: {
        Row: {
          api_key_id: string | null
          created_at: string
          error_message: string | null
          id: string
          model_name: string
          response_time_ms: number | null
          status: string
          task_type: string
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          model_name: string
          response_time_ms?: number | null
          status: string
          task_type: string
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          model_name?: string
          response_time_ms?: number | null
          status?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "model_performance_logs_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          daily_credits_used: number
          email: string | null
          full_name: string | null
          id: string
          last_reset_date: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          daily_credits_used?: number
          email?: string | null
          full_name?: string | null
          id: string
          last_reset_date?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          daily_credits_used?: number
          email?: string | null
          full_name?: string | null
          id?: string
          last_reset_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      promotions: {
        Row: {
          created_at: string
          description: string | null
          end_date: string
          id: string
          is_active: boolean
          name: string
          start_date: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          end_date: string
          id?: string
          is_active?: boolean
          name: string
          start_date: string
        }
        Update: {
          created_at?: string
          description?: string | null
          end_date?: string
          id?: string
          is_active?: boolean
          name?: string
          start_date?: string
        }
        Relationships: []
      }
      reading_paragraphs: {
        Row: {
          content: string
          created_at: string
          id: string
          is_heading: boolean
          label: string
          order_index: number
          passage_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          is_heading?: boolean
          label: string
          order_index: number
          passage_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          is_heading?: boolean
          label?: string
          order_index?: number
          passage_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reading_paragraphs_passage_id_fkey"
            columns: ["passage_id"]
            isOneToOne: false
            referencedRelation: "reading_passages"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_passages: {
        Row: {
          content: string
          created_at: string
          id: string
          passage_number: number
          show_labels: boolean
          test_id: string
          title: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          passage_number: number
          show_labels?: boolean
          test_id: string
          title: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          passage_number?: number
          show_labels?: boolean
          test_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "reading_passages_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "reading_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_question_groups: {
        Row: {
          created_at: string
          display_as_paragraph: boolean | null
          end_question: number
          id: string
          instruction: string | null
          options: Json | null
          passage_id: string
          question_type: string
          show_bullets: boolean | null
          show_headings: boolean | null
          start_question: number
          use_dropdown: boolean | null
        }
        Insert: {
          created_at?: string
          display_as_paragraph?: boolean | null
          end_question: number
          id?: string
          instruction?: string | null
          options?: Json | null
          passage_id: string
          question_type: string
          show_bullets?: boolean | null
          show_headings?: boolean | null
          start_question: number
          use_dropdown?: boolean | null
        }
        Update: {
          created_at?: string
          display_as_paragraph?: boolean | null
          end_question?: number
          id?: string
          instruction?: string | null
          options?: Json | null
          passage_id?: string
          question_type?: string
          show_bullets?: boolean | null
          show_headings?: boolean | null
          start_question?: number
          use_dropdown?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "reading_question_groups_passage_id_fkey"
            columns: ["passage_id"]
            isOneToOne: false
            referencedRelation: "reading_passages"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_questions: {
        Row: {
          correct_answer: string
          created_at: string
          heading: string | null
          id: string
          instruction: string | null
          option_format: string | null
          options: Json | null
          passage_id: string
          question_group_id: string | null
          question_number: number
          question_text: string
          question_type: string
          table_data: Json | null
        }
        Insert: {
          correct_answer: string
          created_at?: string
          heading?: string | null
          id?: string
          instruction?: string | null
          option_format?: string | null
          options?: Json | null
          passage_id: string
          question_group_id?: string | null
          question_number: number
          question_text: string
          question_type: string
          table_data?: Json | null
        }
        Update: {
          correct_answer?: string
          created_at?: string
          heading?: string | null
          id?: string
          instruction?: string | null
          option_format?: string | null
          options?: Json | null
          passage_id?: string
          question_group_id?: string | null
          question_number?: number
          question_text?: string
          question_type?: string
          table_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "reading_questions_passage_id_fkey"
            columns: ["passage_id"]
            isOneToOne: false
            referencedRelation: "reading_passages"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_test_submissions: {
        Row: {
          answers: Json
          band_score: number | null
          completed_at: string
          created_at: string
          id: string
          score: number
          test_id: string
          total_questions: number
          user_id: string
        }
        Insert: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          id?: string
          score?: number
          test_id: string
          total_questions?: number
          user_id: string
        }
        Update: {
          answers?: Json
          band_score?: number | null
          completed_at?: string
          created_at?: string
          id?: string
          score?: number
          test_id?: string
          total_questions?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reading_test_submissions_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "reading_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_tests: {
        Row: {
          book_name: string
          created_at: string
          id: string
          is_published: boolean
          test_number: number
          test_type: string
          time_limit: number
          title: string
          total_questions: number
          updated_at: string
        }
        Insert: {
          book_name: string
          created_at?: string
          id?: string
          is_published?: boolean
          test_number: number
          test_type?: string
          time_limit?: number
          title: string
          total_questions?: number
          updated_at?: string
        }
        Update: {
          book_name?: string
          created_at?: string
          id?: string
          is_published?: boolean
          test_number?: number
          test_type?: string
          time_limit?: number
          title?: string
          total_questions?: number
          updated_at?: string
        }
        Relationships: []
      }
      speaking_evaluation_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          current_part: number | null
          difficulty: string | null
          durations: Json | null
          file_paths: Json
          fluency_flag: boolean | null
          google_file_uris: Json | null
          groq_llm_key_id: string | null
          groq_retry_count: number | null
          groq_stt_key_id: string | null
          heartbeat_at: string | null
          id: string
          last_error: string | null
          lock_expires_at: string | null
          lock_token: string | null
          max_retries: number | null
          partial_results: Json | null
          preset_id: string | null
          processing_started_at: string | null
          progress: number | null
          provider: string | null
          result_id: string | null
          retry_count: number | null
          stage: string | null
          status: string
          test_id: string
          topic: string | null
          total_parts: number | null
          transcription_result: Json | null
          updated_at: string
          upload_api_key_id: string | null
          upload_completed_at: string | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_part?: number | null
          difficulty?: string | null
          durations?: Json | null
          file_paths?: Json
          fluency_flag?: boolean | null
          google_file_uris?: Json | null
          groq_llm_key_id?: string | null
          groq_retry_count?: number | null
          groq_stt_key_id?: string | null
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          lock_expires_at?: string | null
          lock_token?: string | null
          max_retries?: number | null
          partial_results?: Json | null
          preset_id?: string | null
          processing_started_at?: string | null
          progress?: number | null
          provider?: string | null
          result_id?: string | null
          retry_count?: number | null
          stage?: string | null
          status?: string
          test_id: string
          topic?: string | null
          total_parts?: number | null
          transcription_result?: Json | null
          updated_at?: string
          upload_api_key_id?: string | null
          upload_completed_at?: string | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_part?: number | null
          difficulty?: string | null
          durations?: Json | null
          file_paths?: Json
          fluency_flag?: boolean | null
          google_file_uris?: Json | null
          groq_llm_key_id?: string | null
          groq_retry_count?: number | null
          groq_stt_key_id?: string | null
          heartbeat_at?: string | null
          id?: string
          last_error?: string | null
          lock_expires_at?: string | null
          lock_token?: string | null
          max_retries?: number | null
          partial_results?: Json | null
          preset_id?: string | null
          processing_started_at?: string | null
          progress?: number | null
          provider?: string | null
          result_id?: string | null
          retry_count?: number | null
          stage?: string | null
          status?: string
          test_id?: string
          topic?: string | null
          total_parts?: number | null
          transcription_result?: Json | null
          updated_at?: string
          upload_api_key_id?: string | null
          upload_completed_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "speaking_evaluation_jobs_groq_llm_key_id_fkey"
            columns: ["groq_llm_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaking_evaluation_jobs_groq_stt_key_id_fkey"
            columns: ["groq_stt_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaking_evaluation_jobs_upload_api_key_id_fkey"
            columns: ["upload_api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      speaking_evaluation_settings: {
        Row: {
          auto_fallback_enabled: boolean
          created_at: string
          gemini_model: string | null
          groq_llm_model: string | null
          groq_stt_model: string | null
          id: string
          max_groq_retries: number
          provider: string
          singleton_key: string
          updated_at: string
        }
        Insert: {
          auto_fallback_enabled?: boolean
          created_at?: string
          gemini_model?: string | null
          groq_llm_model?: string | null
          groq_stt_model?: string | null
          id?: string
          max_groq_retries?: number
          provider?: string
          singleton_key?: string
          updated_at?: string
        }
        Update: {
          auto_fallback_enabled?: boolean
          created_at?: string
          gemini_model?: string | null
          groq_llm_model?: string | null
          groq_stt_model?: string | null
          id?: string
          max_groq_retries?: number
          provider?: string
          singleton_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      speaking_question_groups: {
        Row: {
          created_at: string | null
          cue_card_content: string | null
          cue_card_topic: string | null
          id: string
          instruction: string | null
          min_required_questions: number | null
          options: Json | null
          part_number: number
          preparation_time_seconds: number | null
          speaking_time_seconds: number | null
          test_id: string
          time_limit_seconds: number | null
          total_part_time_limit_seconds: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          cue_card_content?: string | null
          cue_card_topic?: string | null
          id?: string
          instruction?: string | null
          min_required_questions?: number | null
          options?: Json | null
          part_number: number
          preparation_time_seconds?: number | null
          speaking_time_seconds?: number | null
          test_id: string
          time_limit_seconds?: number | null
          total_part_time_limit_seconds?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          cue_card_content?: string | null
          cue_card_topic?: string | null
          id?: string
          instruction?: string | null
          min_required_questions?: number | null
          options?: Json | null
          part_number?: number
          preparation_time_seconds?: number | null
          speaking_time_seconds?: number | null
          test_id?: string
          time_limit_seconds?: number | null
          total_part_time_limit_seconds?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "speaking_question_groups_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "speaking_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      speaking_questions: {
        Row: {
          audio_url: string | null
          created_at: string | null
          group_id: string
          id: string
          is_required: boolean
          order_index: number
          question_number: number
          question_text: string
          updated_at: string | null
        }
        Insert: {
          audio_url?: string | null
          created_at?: string | null
          group_id: string
          id?: string
          is_required?: boolean
          order_index: number
          question_number: number
          question_text: string
          updated_at?: string | null
        }
        Update: {
          audio_url?: string | null
          created_at?: string | null
          group_id?: string
          id?: string
          is_required?: boolean
          order_index?: number
          question_number?: number
          question_text?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "speaking_questions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "speaking_question_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      speaking_shared_audio: {
        Row: {
          audio_key: string
          audio_url: string | null
          created_at: string
          description: string | null
          display_order: number
          fallback_text: string
          id: string
          updated_at: string
        }
        Insert: {
          audio_key: string
          audio_url?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          fallback_text: string
          id?: string
          updated_at?: string
        }
        Update: {
          audio_key?: string
          audio_url?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          fallback_text?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      speaking_submissions: {
        Row: {
          audio_url_part1: string | null
          audio_url_part2: string | null
          audio_url_part3: string | null
          created_at: string | null
          evaluation_report: Json | null
          id: string
          overall_band: number | null
          submitted_at: string | null
          test_id: string
          transcript_part1: string | null
          transcript_part2: string | null
          transcript_part3: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          audio_url_part1?: string | null
          audio_url_part2?: string | null
          audio_url_part3?: string | null
          created_at?: string | null
          evaluation_report?: Json | null
          id?: string
          overall_band?: number | null
          submitted_at?: string | null
          test_id: string
          transcript_part1?: string | null
          transcript_part2?: string | null
          transcript_part3?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          audio_url_part1?: string | null
          audio_url_part2?: string | null
          audio_url_part3?: string | null
          created_at?: string | null
          evaluation_report?: Json | null
          id?: string
          overall_band?: number | null
          submitted_at?: string | null
          test_id?: string
          transcript_part1?: string | null
          transcript_part2?: string | null
          transcript_part3?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "speaking_submissions_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "speaking_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      speaking_tests: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_published: boolean
          name: string
          test_type: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_published?: boolean
          name: string
          test_type?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_published?: boolean
          name?: string
          test_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          created_at: string
          end_date: string
          id: string
          plan_name: string
          price: number
          start_date: string
          status: Database["public"]["Enums"]["subscription_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          end_date: string
          id?: string
          plan_name: string
          price: number
          start_date?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          end_date?: string
          id?: string
          plan_name?: string
          price?: number
          start_date?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      test_presets: {
        Row: {
          created_at: string
          id: string
          is_published: boolean
          module: string
          payload: Json
          topic: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_published?: boolean
          module: string
          payload?: Json
          topic: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_published?: boolean
          module?: string
          payload?: Json
          topic?: string
          updated_at?: string
        }
        Relationships: []
      }
      test_results: {
        Row: {
          answers: Json | null
          band_score: number | null
          completed_at: string
          created_at: string
          feedback: Json | null
          id: string
          score: number | null
          test_type: string
          user_id: string
        }
        Insert: {
          answers?: Json | null
          band_score?: number | null
          completed_at?: string
          created_at?: string
          feedback?: Json | null
          id?: string
          score?: number | null
          test_type: string
          user_id: string
        }
        Update: {
          answers?: Json | null
          band_score?: number | null
          completed_at?: string
          created_at?: string
          feedback?: Json | null
          id?: string
          score?: number | null
          test_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_results_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_analytics: {
        Row: {
          analysis_data: Json
          created_at: string
          generated_at: string
          id: string
          module_type: string
          tests_analyzed: number
          user_id: string
        }
        Insert: {
          analysis_data?: Json
          created_at?: string
          generated_at?: string
          id?: string
          module_type: string
          tests_analyzed?: number
          user_id: string
        }
        Update: {
          analysis_data?: Json
          created_at?: string
          generated_at?: string
          id?: string
          module_type?: string
          tests_analyzed?: number
          user_id?: string
        }
        Relationships: []
      }
      user_api_keys: {
        Row: {
          created_at: string
          flash_2_5_quota_exhausted: boolean | null
          flash_2_5_quota_exhausted_date: string | null
          id: string
          is_active: boolean
          key_value: string
          provider: string
          tts_quota_exhausted: boolean | null
          tts_quota_exhausted_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          flash_2_5_quota_exhausted?: boolean | null
          flash_2_5_quota_exhausted_date?: string | null
          id?: string
          is_active?: boolean
          key_value: string
          provider?: string
          tts_quota_exhausted?: boolean | null
          tts_quota_exhausted_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          flash_2_5_quota_exhausted?: boolean | null
          flash_2_5_quota_exhausted_date?: string | null
          id?: string
          is_active?: boolean
          key_value?: string
          provider?: string
          tts_quota_exhausted?: boolean | null
          tts_quota_exhausted_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_secrets: {
        Row: {
          created_at: string | null
          encrypted_value: string
          id: string
          secret_name: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          encrypted_value: string
          id?: string
          secret_name: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          encrypted_value?: string
          id?: string
          secret_name?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_test_history: {
        Row: {
          id: string
          taken_at: string
          test_id: string
          user_id: string
        }
        Insert: {
          id?: string
          taken_at?: string
          test_id: string
          user_id: string
        }
        Update: {
          id?: string
          taken_at?: string
          test_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_test_history_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "generated_test_audio"
            referencedColumns: ["id"]
          },
        ]
      }
      writing_submissions: {
        Row: {
          evaluation_report: Json | null
          id: string
          overall_band: number | null
          submission_text: string
          submitted_at: string | null
          task_id: string
          user_id: string
          word_count: number
        }
        Insert: {
          evaluation_report?: Json | null
          id?: string
          overall_band?: number | null
          submission_text: string
          submitted_at?: string | null
          task_id: string
          user_id: string
          word_count: number
        }
        Update: {
          evaluation_report?: Json | null
          id?: string
          overall_band?: number | null
          submission_text?: string
          submitted_at?: string | null
          task_id?: string
          user_id?: string
          word_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "writing_submissions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "writing_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      writing_tasks: {
        Row: {
          created_at: string | null
          id: string
          image_height: number | null
          image_url: string | null
          image_width: number | null
          instruction: string
          task_type: Database["public"]["Enums"]["writing_task_type"]
          text_content: string | null
          updated_at: string | null
          word_limit_max: number | null
          word_limit_min: number
          writing_test_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          image_height?: number | null
          image_url?: string | null
          image_width?: number | null
          instruction: string
          task_type: Database["public"]["Enums"]["writing_task_type"]
          text_content?: string | null
          updated_at?: string | null
          word_limit_max?: number | null
          word_limit_min?: number
          writing_test_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          image_height?: number | null
          image_url?: string | null
          image_width?: number | null
          instruction?: string
          task_type?: Database["public"]["Enums"]["writing_task_type"]
          text_content?: string | null
          updated_at?: string | null
          word_limit_max?: number | null
          word_limit_min?: number
          writing_test_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "writing_tasks_writing_test_id_fkey"
            columns: ["writing_test_id"]
            isOneToOne: false
            referencedRelation: "writing_tests"
            referencedColumns: ["id"]
          },
        ]
      }
      writing_tests: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_published: boolean
          time_limit: number
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean
          time_limit?: number
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_published?: boolean
          time_limit?: number
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_user_submit: { Args: { p_user_id: string }; Returns: boolean }
      check_and_reserve_credits: {
        Args: { p_cost: number; p_user_id: string }
        Returns: Json
      }
      checkout_api_key: {
        Args: {
          p_job_id: string
          p_lock_minutes?: number
          p_model_name: string
        }
        Returns: {
          key_id: string
          key_value: string
        }[]
      }
      checkout_groq_key_for_llm: {
        Args: {
          p_job_id: string
          p_lock_duration_seconds?: number
          p_part_number?: number
        }
        Returns: {
          out_key_id: string
          out_key_value: string
        }[]
      }
      checkout_groq_key_for_stt: {
        Args: {
          p_job_id: string
          p_lock_duration_seconds?: number
          p_part_number?: number
        }
        Returns: {
          out_key_id: string
          out_key_value: string
        }[]
      }
      checkout_key_for_part: {
        Args: {
          p_job_id: string
          p_lock_duration_seconds?: number
          p_model_name?: string
          p_part_number: number
        }
        Returns: Record<string, unknown>[]
      }
      checkout_key_for_part_v2: {
        Args: {
          p_job_id: string
          p_lock_duration_seconds?: number
          p_model_name?: string
          p_part_number: number
        }
        Returns: Record<string, unknown>[]
      }
      cleanup_old_data: { Args: never; Returns: Json }
      cleanup_old_key_locks: { Args: never; Returns: number }
      get_credit_status: { Args: { p_user_id: string }; Returns: Json }
      get_model_performance_stats: {
        Args: { p_hours?: number }
        Returns: {
          avg_response_time_ms: number
          error_count: number
          model_name: string
          quota_exceeded_count: number
          success_count: number
          success_rate: number
          task_type: string
          total_calls: number
        }[]
      }
      get_speaking_evaluation_provider: { Args: never; Returns: string }
      has_active_subscription: { Args: { p_user_id: string }; Returns: boolean }
      increment_topic_completion: {
        Args: { p_module: string; p_topic: string; p_user_id: string }
        Returns: undefined
      }
      is_admin: { Args: { check_user_id: string }; Returns: boolean }
      is_promotion_active: { Args: never; Returns: boolean }
      log_model_performance: {
        Args: {
          p_api_key_id: string
          p_error_message?: string
          p_model_name: string
          p_response_time_ms?: number
          p_status: string
          p_task_type: string
        }
        Returns: undefined
      }
      mark_groq_key_exhausted:
        | { Args: { p_key_id: string; p_model: string }; Returns: undefined }
        | { Args: { p_key_id: string; p_model: string }; Returns: undefined }
      mark_groq_key_rpm_limited: {
        Args: { p_cooldown_seconds?: number; p_key_id: string }
        Returns: undefined
      }
      mark_key_rate_limited: {
        Args: { p_cooldown_minutes?: number; p_key_id: string }
        Returns: undefined
      }
      record_groq_ash_usage: {
        Args: { p_audio_seconds: number; p_key_id: string }
        Returns: undefined
      }
      refund_credits: {
        Args: { p_cost: number; p_user_id: string }
        Returns: undefined
      }
      release_api_key: { Args: { p_job_id: string }; Returns: undefined }
      release_key_with_cooldown: {
        Args: {
          p_cooldown_seconds?: number
          p_job_id: string
          p_part_number: number
        }
        Returns: undefined
      }
      reset_api_key_model_quotas: {
        Args: { p_key_id?: string }
        Returns: undefined
      }
      reset_api_key_quotas: { Args: never; Returns: undefined }
      reset_groq_model_quotas: {
        Args: { p_key_id?: string }
        Returns: undefined
      }
      reset_key_rate_limit: { Args: { p_key_id: string }; Returns: undefined }
      reset_user_api_key_quotas: { Args: never; Returns: undefined }
    }
    Enums: {
      subscription_status: "active" | "cancelled" | "expired" | "pending"
      writing_task_type: "task1" | "task2"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      subscription_status: ["active", "cancelled", "expired", "pending"],
      writing_task_type: ["task1", "task2"],
    },
  },
} as const
