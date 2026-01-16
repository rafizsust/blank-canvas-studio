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
      admission_requests: {
        Row: {
          approved_password: string | null
          approved_shadow_id: string | null
          bkash_transaction_id: string | null
          class_name: string
          created_at: string
          credentials_sent: boolean | null
          credentials_sent_at: string | null
          guardian_phone: string
          id: string
          photo_url: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by_user_id: string | null
          status: string
          student_name: string
          telegram_chat_id: string | null
          updated_at: string
        }
        Insert: {
          approved_password?: string | null
          approved_shadow_id?: string | null
          bkash_transaction_id?: string | null
          class_name: string
          created_at?: string
          credentials_sent?: boolean | null
          credentials_sent_at?: string | null
          guardian_phone: string
          id?: string
          photo_url?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          student_name: string
          telegram_chat_id?: string | null
          updated_at?: string
        }
        Update: {
          approved_password?: string | null
          approved_shadow_id?: string | null
          bkash_transaction_id?: string | null
          class_name?: string
          created_at?: string
          credentials_sent?: boolean | null
          credentials_sent_at?: string | null
          guardian_phone?: string
          id?: string
          photo_url?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by_user_id?: string | null
          status?: string
          student_name?: string
          telegram_chat_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "admission_requests_reviewed_by_user_id_fkey"
            columns: ["reviewed_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          created_at: string | null
          date: string
          id: string
          recorded_by_user_id: string
          status: Database["public"]["Enums"]["attendance_status"]
          student_user_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          date: string
          id?: string
          recorded_by_user_id: string
          status: Database["public"]["Enums"]["attendance_status"]
          student_user_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          date?: string
          id?: string
          recorded_by_user_id?: string
          status?: Database["public"]["Enums"]["attendance_status"]
          student_user_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_attendance_student_user_id"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["user_id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          created_at: string
          id: string
          message_text: string
          replied_to_message_id: string | null
          sender_id: string
          sender_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_text: string
          replied_to_message_id?: string | null
          sender_id: string
          sender_name: string
        }
        Update: {
          created_at?: string
          id?: string
          message_text?: string
          replied_to_message_id?: string | null
          sender_id?: string
          sender_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_replied_to_message_id_fkey"
            columns: ["replied_to_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      class_outlines: {
        Row: {
          class_name: string
          created_at: string | null
          created_by_user_id: string | null
          id: string
          lesson_plan: Json
          outline_date: string
          updated_at: string | null
        }
        Insert: {
          class_name: string
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string
          lesson_plan?: Json
          outline_date: string
          updated_at?: string | null
        }
        Update: {
          class_name?: string
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string
          lesson_plan?: Json
          outline_date?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      coaching_balance: {
        Row: {
          current_balance: number
          id: string
          updated_at: string | null
        }
        Insert: {
          current_balance?: number
          id?: string
          updated_at?: string | null
        }
        Update: {
          current_balance?: number
          id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      custom_subjects: {
        Row: {
          created_at: string | null
          created_by_user_id: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          created_by_user_id?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      dues: {
        Row: {
          class_name: string
          created_at: string | null
          due_amount: number
          id: string
          months_due: string | null
          shadow_id: string
          student_name: string
          student_user_id: string
          updated_at: string | null
        }
        Insert: {
          class_name: string
          created_at?: string | null
          due_amount: number
          id?: string
          months_due?: string | null
          shadow_id: string
          student_name: string
          student_user_id: string
          updated_at?: string | null
        }
        Update: {
          class_name?: string
          created_at?: string | null
          due_amount?: number
          id?: string
          months_due?: string | null
          shadow_id?: string
          student_name?: string
          student_user_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      exam_schedules: {
        Row: {
          class_name: string
          created_at: string | null
          created_by_user_id: string | null
          exam_date: string
          exam_type: string
          id: string
          syllabus: Json
          updated_at: string | null
        }
        Insert: {
          class_name: string
          created_at?: string | null
          created_by_user_id?: string | null
          exam_date: string
          exam_type: string
          id?: string
          syllabus?: Json
          updated_at?: string | null
        }
        Update: {
          class_name?: string
          created_at?: string | null
          created_by_user_id?: string | null
          exam_date?: string
          exam_type?: string
          id?: string
          syllabus?: Json
          updated_at?: string | null
        }
        Relationships: []
      }
      expenses: {
        Row: {
          amount: number
          created_at: string | null
          description: string
          expense_date: string
          id: string
          recorded_by_user_id: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          description: string
          expense_date: string
          id?: string
          recorded_by_user_id: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string
          expense_date?: string
          id?: string
          recorded_by_user_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      finance_transactions: {
        Row: {
          amount: number
          cleared_at: string | null
          cleared_by_user_id: string | null
          created_at: string | null
          description: string | null
          id: string
          is_partial_payment: boolean | null
          month: number
          recorded_by_user_id: string | null
          related_student_id: string | null
          related_teacher_id: string | null
          transaction_date: string
          type: Database["public"]["Enums"]["finance_transaction_type"]
          updated_at: string | null
          user_id: string | null
          year: number
        }
        Insert: {
          amount: number
          cleared_at?: string | null
          cleared_by_user_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_partial_payment?: boolean | null
          month: number
          recorded_by_user_id?: string | null
          related_student_id?: string | null
          related_teacher_id?: string | null
          transaction_date: string
          type: Database["public"]["Enums"]["finance_transaction_type"]
          updated_at?: string | null
          user_id?: string | null
          year: number
        }
        Update: {
          amount?: number
          cleared_at?: string | null
          cleared_by_user_id?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_partial_payment?: boolean | null
          month?: number
          recorded_by_user_id?: string | null
          related_student_id?: string | null
          related_teacher_id?: string | null
          transaction_date?: string
          type?: Database["public"]["Enums"]["finance_transaction_type"]
          updated_at?: string | null
          user_id?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "finance_transactions_related_student_id_fkey"
            columns: ["related_student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_transactions_related_teacher_id_fkey"
            columns: ["related_teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          content: string
          created_at: string | null
          id: string
          is_announcement: boolean | null
          is_public: boolean | null
          posted_by_user_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          is_announcement?: boolean | null
          is_public?: boolean | null
          posted_by_user_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          is_announcement?: boolean | null
          is_public?: boolean | null
          posted_by_user_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      results: {
        Row: {
          created_at: string | null
          exam_date: string
          grade: string | null
          id: string
          imported_by_user_id: string | null
          score: number | null
          student_user_id: string
          subject: string
          total_marks: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          exam_date: string
          grade?: string | null
          id?: string
          imported_by_user_id?: string | null
          score?: number | null
          student_user_id: string
          subject: string
          total_marks?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          exam_date?: string
          grade?: string | null
          id?: string
          imported_by_user_id?: string | null
          score?: number | null
          student_user_id?: string
          subject?: string
          total_marks?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_results_imported_by_user"
            columns: ["imported_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_results_student_user"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_imported_by_user_id_fkey"
            columns: ["imported_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_student_user_id_fkey"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          class_name: string | null
          created_at: string | null
          description: string | null
          end_time: string
          id: string
          location: string | null
          start_time: string
          teacher_user_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          class_name?: string | null
          created_at?: string | null
          description?: string | null
          end_time: string
          id?: string
          location?: string | null
          start_time: string
          teacher_user_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          class_name?: string | null
          created_at?: string | null
          description?: string | null
          end_time?: string
          id?: string
          location?: string | null
          start_time?: string
          teacher_user_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      scholarship_lists: {
        Row: {
          created_at: string
          created_by_user_id: string
          id: string
          is_published: boolean
          published_at: string | null
          updated_at: string
          year: number
        }
        Insert: {
          created_at?: string
          created_by_user_id: string
          id?: string
          is_published?: boolean
          published_at?: string | null
          updated_at?: string
          year: number
        }
        Update: {
          created_at?: string
          created_by_user_id?: string
          id?: string
          is_published?: boolean
          published_at?: string | null
          updated_at?: string
          year?: number
        }
        Relationships: []
      }
      scholarship_students: {
        Row: {
          class_name: string
          contact_number: string
          created_at: string
          created_by_user_id: string
          id: string
          scholarship_list_id: string
          school_name: string
          student_name: string
          updated_at: string
        }
        Insert: {
          class_name: string
          contact_number: string
          created_at?: string
          created_by_user_id: string
          id?: string
          scholarship_list_id: string
          school_name: string
          student_name: string
          updated_at?: string
        }
        Update: {
          class_name?: string
          contact_number?: string
          created_at?: string
          created_by_user_id?: string
          id?: string
          scholarship_list_id?: string
          school_name?: string
          student_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scholarship_students_scholarship_list_id_fkey"
            columns: ["scholarship_list_id"]
            isOneToOne: false
            referencedRelation: "scholarship_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      student_dues: {
        Row: {
          amount_paid: number
          cleared_at: string | null
          cleared_by_user_id: string | null
          created_at: string | null
          discount_amount: number
          id: string
          is_cleared: boolean
          month: number
          monthly_fee: number
          student_user_id: string
          updated_at: string | null
          year: number
        }
        Insert: {
          amount_paid?: number
          cleared_at?: string | null
          cleared_by_user_id?: string | null
          created_at?: string | null
          discount_amount?: number
          id?: string
          is_cleared?: boolean
          month: number
          monthly_fee?: number
          student_user_id: string
          updated_at?: string | null
          year: number
        }
        Update: {
          amount_paid?: number
          cleared_at?: string | null
          cleared_by_user_id?: string | null
          created_at?: string | null
          discount_amount?: number
          id?: string
          is_cleared?: boolean
          month?: number
          monthly_fee?: number
          student_user_id?: string
          updated_at?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_student_dues_student_user_id"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["user_id"]
          },
        ]
      }
      student_result_views: {
        Row: {
          id: string
          result_id: string
          student_user_id: string
          viewed_at: string
        }
        Insert: {
          id?: string
          result_id: string
          student_user_id: string
          viewed_at?: string
        }
        Update: {
          id?: string
          result_id?: string
          student_user_id?: string
          viewed_at?: string
        }
        Relationships: []
      }
      student_yearly_discounts: {
        Row: {
          created_at: string | null
          created_by_user_id: string
          discount_amount_per_month: number
          id: string
          student_user_id: string
          updated_at: string | null
          year: number
        }
        Insert: {
          created_at?: string | null
          created_by_user_id: string
          discount_amount_per_month: number
          id?: string
          student_user_id: string
          updated_at?: string | null
          year: number
        }
        Update: {
          created_at?: string | null
          created_by_user_id?: string
          discount_amount_per_month?: number
          id?: string
          student_user_id?: string
          updated_at?: string | null
          year?: number
        }
        Relationships: []
      }
      students: {
        Row: {
          class: string
          created_at: string | null
          guardian_phone: string
          id: string
          is_active: boolean | null
          name: string
          photo_url: string | null
          shadow_id: string
          telegram_chat_id: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          class: string
          created_at?: string | null
          guardian_phone: string
          id?: string
          is_active?: boolean | null
          name: string
          photo_url?: string | null
          shadow_id: string
          telegram_chat_id?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          class?: string
          created_at?: string | null
          guardian_phone?: string
          id?: string
          is_active?: boolean | null
          name?: string
          photo_url?: string | null
          shadow_id?: string
          telegram_chat_id?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      teacher_balances: {
        Row: {
          created_at: string | null
          current_balance: number
          id: string
          teacher_user_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_balance?: number
          id?: string
          teacher_user_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_balance?: number
          id?: string
          teacher_user_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      teacher_salaries: {
        Row: {
          created_at: string | null
          created_by_user_id: string
          id: string
          monthly_salary: number
          teacher_user_id: string
          updated_at: string | null
          year: number
        }
        Insert: {
          created_at?: string | null
          created_by_user_id: string
          id?: string
          monthly_salary: number
          teacher_user_id: string
          updated_at?: string | null
          year: number
        }
        Update: {
          created_at?: string | null
          created_by_user_id?: string
          id?: string
          monthly_salary?: number
          teacher_user_id?: string
          updated_at?: string | null
          year?: number
        }
        Relationships: []
      }
      teachers: {
        Row: {
          created_at: string | null
          experience: string | null
          expertise: string | null
          id: string
          mobile_number: string | null
          name: string
          photo_url: string | null
          shadow_id: string
          teacher_type: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          experience?: string | null
          expertise?: string | null
          id?: string
          mobile_number?: string | null
          name: string
          photo_url?: string | null
          shadow_id: string
          teacher_type?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          experience?: string | null
          expertise?: string | null
          id?: string
          mobile_number?: string | null
          name?: string
          photo_url?: string | null
          shadow_id?: string
          teacher_type?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string | null
          email: string | null
          id: string
          name: string
          photo_url: string | null
          role: Database["public"]["Enums"]["user_role"]
          shadow_id: string
          teacher_type: Database["public"]["Enums"]["user_teacher_type"] | null
          telegram_chat_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id: string
          name: string
          photo_url?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          shadow_id: string
          teacher_type?: Database["public"]["Enums"]["user_teacher_type"] | null
          telegram_chat_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          photo_url?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          shadow_id?: string
          teacher_type?: Database["public"]["Enums"]["user_teacher_type"] | null
          telegram_chat_id?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      attendance_records_view: {
        Row: {
          date: string | null
          id: string | null
          recorded_by_user_id: string | null
          status: Database["public"]["Enums"]["attendance_status"] | null
          student_class: string | null
          student_name: string | null
          student_shadow_id: string | null
          student_user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_attendance_student_user_id"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["user_id"]
          },
        ]
      }
      attendance_summary_view: {
        Row: {
          absent_count: number | null
          class_name: string | null
          date: string | null
          late_count: number | null
          present_count: number | null
          recorded_by_user_id: string | null
          total_students: number | null
        }
        Relationships: []
      }
      student_dues_with_student_info_view: {
        Row: {
          amount_paid: number | null
          discount_amount: number | null
          id: string | null
          is_cleared: boolean | null
          month: number | null
          monthly_fee: number | null
          student_class: string | null
          student_name: string | null
          student_shadow_id: string | null
          student_user_id: string | null
          year: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_student_dues_student_user_id"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["user_id"]
          },
        ]
      }
      student_results_view: {
        Row: {
          created_at: string | null
          exam_date: string | null
          grade: string | null
          id: string | null
          imported_by_user_id: string | null
          score: number | null
          student_class: string | null
          student_name: string | null
          student_shadow_id: string | null
          student_user_id: string | null
          subject: string | null
          total_marks: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_results_imported_by_user"
            columns: ["imported_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_results_student_user"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_imported_by_user_id_fkey"
            columns: ["imported_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "results_student_user_id_fkey"
            columns: ["student_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      is_admin:
        | { Args: never; Returns: boolean }
        | { Args: { user_id: string }; Returns: boolean }
      is_student: { Args: never; Returns: boolean }
      is_teacher:
        | { Args: never; Returns: boolean }
        | { Args: { user_id: string }; Returns: boolean }
    }
    Enums: {
      attendance_status: "present" | "absent" | "late"
      finance_transaction_type:
        | "student_payment"
        | "teacher_salary_credit"
        | "teacher_salary_debit"
        | "expense"
        | "shareholder_profit_credit"
        | "shareholder_profit_debit"
      user_role: "admin" | "teacher" | "student"
      user_teacher_type: "general" | "shareholder"
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
      attendance_status: ["present", "absent", "late"],
      finance_transaction_type: [
        "student_payment",
        "teacher_salary_credit",
        "teacher_salary_debit",
        "expense",
        "shareholder_profit_credit",
        "shareholder_profit_debit",
      ],
      user_role: ["admin", "teacher", "student"],
      user_teacher_type: ["general", "shareholder"],
    },
  },
} as const
