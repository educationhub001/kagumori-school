/**
 * Supabase API layer for A.C.K Kagumori School Management System
 * Drop-in replacement for the old Express /api/* routes.
 *
 * Requires:
 *   - config.js (SUPABASE_URL, SUPABASE_ANON_KEY)
 *   - @supabase/supabase-js (CDN or module)
 */
(function (global) {
  'use strict';

  if (!global.supabase || !global.SUPABASE_URL || !global.SUPABASE_ANON_KEY) {
    console.error('Supabase client or config missing. Load config.js and supabase-js first.');
  }

  // Session lives only for this tab while the app is open.
  // Sign-out on leave / Sign Out clears storage (see index.html).
  // Use sessionStorage so closing the tab does not keep a login around.
  try {
    // Drop any legacy tokens that kept users signed in after closing the app
    const ls = global.localStorage;
    if (ls) {
      const keys = [];
      for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
      keys.forEach(function (k) {
        if (!k) return;
        if (k === 'kagumori_session' || k.indexOf('sb-') === 0 || /supabase/i.test(k)) {
          try { ls.removeItem(k); } catch (_) {}
        }
      });
    }
  } catch (_) {}

  const sb = global.supabase.createClient(
    global.SUPABASE_URL,
    global.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: global.sessionStorage
      }
    }
  );

  // ---------- helpers ----------
  function levelSubjects(cls) {
    const PREPRIMARY = ['PP1', 'PP2'];
    const LOWER = ['Grade 1', 'Grade 2', 'Grade 3'];
    const UPPER = ['Grade 4', 'Grade 5', 'Grade 6'];
    if (PREPRIMARY.includes(cls)) return ['math', 'eng', 'kisw', 'cas', 'cre'];
    if (LOWER.includes(cls)) return ['math', 'eng', 'kisw', 'ins'];
    if (UPPER.includes(cls)) return ['math', 'eng', 'kisw', 'ins', 'ss', 'cas'];
    return ['eng', 'math', 'kisw', 'ss', 'cas', 'agri', 'ins', 'pre_tech', 'cre'];
  }

  const CODE_TO_COL = {
    Eng: 'eng', Math: 'math', Kisw: 'kisw',
    'S/S': 'ss', 'S/S&C.R.E': 'ss', ss: 'ss',
    'C.A.S': 'cas', CAS: 'cas', Creative: 'cas', cas: 'cas',
    Agri: 'agri', agri: 'agri',
    Ins: 'ins', INT: 'ins', ILA: 'ins', ins: 'ins',
    'Pre-Tech': 'pre_tech', pre_tech: 'pre_tech',
    'C.R.E': 'cre', 'Env&Rel': 'cre', cre: 'cre'
  };

  async function requireSession() {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error || !session) {
      const err = new Error('Session expired. Please sign in again.');
      err.status = 401;
      throw err;
    }
    return session;
  }

  async function requireAdmin() {
    const session = await requireSession();
    const resolved = await resolveUserRole(session.user);
    if (resolved.role !== 'admin') {
      const err = new Error('Only an administrator can do this.');
      err.status = 403;
      throw err;
    }
    return session;
  }

  async function uploadFile(bucket, path, file) {
    const { error } = await sb.storage.from(bucket).upload(path, file, {
      upsert: true,
      contentType: file.type || undefined
    });
    if (error) throw new Error(error.message);
    if (bucket === 'learner-profiles') {
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    }
    // private: store path; signed URL generated when needed
    return path;
  }

  async function removeStoragePath(bucket, pathOrUrl) {
    if (!pathOrUrl) return;
    let path = pathOrUrl;
    // strip public URL prefix if present
    const marker = `/object/public/${bucket}/`;
    const idx = pathOrUrl.indexOf(marker);
    if (idx >= 0) path = pathOrUrl.slice(idx + marker.length);
    await sb.storage.from(bucket).remove([path]).catch(() => {});
  }

  /**
   * Resolve role for a Supabase auth user.
   * Priority: profiles.role → user_metadata.role → teachers table by email → admin
   * Never default to admin before checking teacher signals.
   */
  async function resolveUserRole(user) {
    const email = (user.email || '').toLowerCase().trim();
    const meta = user.user_metadata || {};
    const metaRole = (meta.role || '').toString().toLowerCase().trim();
    const metaName = meta.name || null;

    let profileRole = null;
    let profileName = null;
    let profileUsername = null;
    let isInTeachersTable = false;
    let teacherName = null;
    // Parallel lookups — faster login under concurrent sign-ins
    try {
      const profileP = sb.from('profiles').select('role, name, username').eq('id', user.id).maybeSingle();
      const teacherP = email
        ? sb.from('teachers').select('first_name, middle_name, surname, email').ilike('email', email).maybeSingle()
        : Promise.resolve({ data: null });
      const [profRes, teachRes] = await Promise.all([profileP, teacherP]);
      const rows = profRes && profRes.data;
      if (rows) {
        if (rows.role) profileRole = String(rows.role).toLowerCase().trim();
        if (rows.name) profileName = rows.name;
        if (rows.username) profileUsername = rows.username;
      }
      const trow = teachRes && teachRes.data;
      if (trow) {
        isInTeachersTable = true;
        teacherName = [trow.first_name, trow.middle_name, trow.surname].filter(Boolean).join(' ');
      }
    } catch (_) {}

    let role = 'admin';
    if (profileRole === 'teacher' || profileRole === 'admin') {
      role = profileRole;
    } else if (metaRole === 'teacher' || metaRole === 'admin') {
      role = metaRole;
    } else if (isInTeachersTable) {
      role = 'teacher';
    } else {
      role = 'admin';
    }

    // If profiles says admin but user is clearly a teacher, prefer teacher
    if (role === 'admin' && (metaRole === 'teacher' || isInTeachersTable)) {
      role = 'teacher';
    }

    const name =
      profileName ||
      metaName ||
      teacherName ||
      (role === 'teacher' ? 'Teacher' : 'Administrator');

    return {
      role,
      name,
      username: profileUsername || email || user.email
    };
  }

  // ---------- public API (mirrors old fetch /api/*) ----------
  const api = {
    /** Low-level access if needed */
    client: sb,

    async login(usernameOrEmail, password) {
      // Admin: email + password. Teacher: email + TSC No as password.
      let email = String(usernameOrEmail || '').trim().toLowerCase();
      if (!email) throw new Error('Email is required');
      if (!email.includes('@')) {
        throw new Error('Enter your full email address');
      }
      const { data, error } = await sb.auth.signInWithPassword({
        email,
        password: String(password || '')
      });
      if (error) {
        throw new Error('Invalid credentials');
      }

      const user = data.user;
      const resolved = await resolveUserRole(user);

      return {
        user: {
          id: user.id,
          username: resolved.username,
          name: resolved.name,
          role: resolved.role,
          email: user.email
        }
      };
    },

    async logout() {
      await sb.auth.signOut();
      return { message: 'Logged out' };
    },

    async me() {
      const session = await requireSession();
      const user = session.user;
      const resolved = await resolveUserRole(user);
      return {
        user: {
          id: user.id,
          username: resolved.username,
          name: resolved.name,
          role: resolved.role,
          email: user.email
        }
      };
    },

    async verifyPassword(password) {
      // Re-authenticate by signing in again with current email
      const session = await requireSession();
      const email = session.user.email;
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error('Incorrect password');
      return { ok: true };
    },

    // ----- LEARNERS -----
    async getLearners() {
      await requireSession();
      // Only columns the UI needs (avoids wide row payloads under concurrent users)
      const { data, error } = await sb
        .from('learners')
        .select('id, upi, first_name, last_name, class, gender, is_alumni, father_name, father_mobile, father_id, mother_name, mother_mobile, mother_id, guardian, mobile, profile_picture, document_path, document_name')
        .order('is_alumni', { ascending: true })
        .order('first_name')
        .order('last_name');
      if (error) throw new Error(error.message);
      return data || [];
    },

    async getLearner(id) {
      await requireSession();
      const { data, error } = await sb.from('learners').select('*').eq('id', id).single();
      if (error) throw new Error(error.message);
      return data;
    },

    async createLearner(formData) {
      await requireAdmin();
      // formData is FormData from the registration form
      const get = (k) => (formData.get(k) || '').toString().trim();

      const body = {
        upi: get('upi'),
        first_name: get('firstName'),
        last_name: get('lastName'),
        class: get('class'),
        gender: get('gender'),
        father_name: get('fatherName') || 'N/A',
        father_mobile: get('fatherMobile') || null,
        father_id: get('fatherId') || null,
        mother_name: get('motherName') || 'N/A',
        mother_mobile: get('motherMobile') || null,
        mother_id: get('motherId') || null,
        guardian: null,
        mobile: null
      };

      // guardian logic (same as server)
      const fNA = !body.father_name || body.father_name.toUpperCase() === 'N/A';
      const mNA = !body.mother_name || body.mother_name.toUpperCase() === 'N/A';
      if (!fNA) {
        body.guardian = body.father_name;
        body.mobile = body.father_mobile;
      } else if (!mNA) {
        body.guardian = body.mother_name;
        body.mobile = body.mother_mobile;
      } else {
        const gn = get('guardianName');
        if (gn && gn.toUpperCase() !== 'N/A') {
          body.guardian = gn;
          body.mobile = get('guardianMobile') || null;
        }
      }

      // uniqueness
      const { data: exist } = await sb.from('learners').select('id').eq('upi', body.upi).maybeSingle();
      if (exist) throw new Error('Kemis No already exists');

      // uploads
      const profileFile = formData.get('profilePicture');
      const docFile = formData.get('document');
      if (profileFile && profileFile.size) {
        const ext = (profileFile.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        body.profile_picture = await uploadFile('learner-profiles', path, profileFile);
      }
      if (docFile && docFile.size) {
        const ext = (docFile.name.split('.').pop() || 'pdf').toLowerCase();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        body.document_path = await uploadFile('learner-documents', path, docFile);
        body.document_name = docFile.name;
      }

      const { data, error } = await sb.from('learners').insert(body).select('id').single();
      if (error) throw new Error(error.message);
      return { id: data.id, message: 'Learner registered' };
    },

    async updateLearner(id, formData) {
      await requireAdmin();
      const get = (k) => (formData.get(k) || '').toString().trim();

      const { data: current, error: curErr } = await sb.from('learners').select('*').eq('id', id).single();
      if (curErr || !current) throw new Error('Learner not found');

      const body = {
        upi: get('upi'),
        first_name: get('firstName'),
        last_name: get('lastName'),
        class: get('class'),
        gender: get('gender'),
        father_name: get('fatherName') || 'N/A',
        father_mobile: get('fatherMobile') || null,
        father_id: get('fatherId') || null,
        mother_name: get('motherName') || 'N/A',
        mother_mobile: get('motherMobile') || null,
        mother_id: get('motherId') || null,
        guardian: null,
        mobile: null,
        profile_picture: current.profile_picture,
        document_path: current.document_path,
        document_name: current.document_name
      };

      const fNA = !body.father_name || body.father_name.toUpperCase() === 'N/A';
      const mNA = !body.mother_name || body.mother_name.toUpperCase() === 'N/A';
      if (!fNA) {
        body.guardian = body.father_name;
        body.mobile = body.father_mobile;
      } else if (!mNA) {
        body.guardian = body.mother_name;
        body.mobile = body.mother_mobile;
      } else {
        const gn = get('guardianName');
        if (gn && gn.toUpperCase() !== 'N/A') {
          body.guardian = gn;
          body.mobile = get('guardianMobile') || null;
        }
      }

      const { data: exist } = await sb.from('learners').select('id').eq('upi', body.upi).neq('id', id).maybeSingle();
      if (exist) throw new Error('Kemis No in use');

      const profileFile = formData.get('profilePicture');
      const docFile = formData.get('document');
      if (profileFile && profileFile.size) {
        await removeStoragePath('learner-profiles', current.profile_picture);
        const ext = (profileFile.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        body.profile_picture = await uploadFile('learner-profiles', path, profileFile);
      }
      if (docFile && docFile.size) {
        await removeStoragePath('learner-documents', current.document_path);
        const ext = (docFile.name.split('.').pop() || 'pdf').toLowerCase();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        body.document_path = await uploadFile('learner-documents', path, docFile);
        body.document_name = docFile.name;
      }
      if (formData.get('clearDocument') === '1' || formData.get('clearDocument') === 'true') {
        await removeStoragePath('learner-documents', current.document_path);
        body.document_path = null;
        body.document_name = null;
      }

      const { error } = await sb.from('learners').update(body).eq('id', id);
      if (error) throw new Error(error.message);
      return { message: 'Updated' };
    },

    async deleteLearner(id) {
      await requireAdmin();
      const { data: row } = await sb.from('learners').select('profile_picture, document_path').eq('id', id).maybeSingle();
      if (row) {
        await removeStoragePath('learner-profiles', row.profile_picture);
        await removeStoragePath('learner-documents', row.document_path);
      }
      // Remove related grades first (in case DB has no ON DELETE CASCADE)
      try {
        await sb.from('grades').delete().eq('learner_id', id);
      } catch (_) {}
      const { error } = await sb.from('learners').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { message: 'Deleted' };
    },

    async promoteLearners(fromClass, password, passwordConfirm) {
      await requireAdmin();
      if (!password || !passwordConfirm) throw new Error('Enter password twice to confirm');
      if (password !== passwordConfirm) throw new Error('Passwords do not match');
      await api.verifyPassword(password);

      const CLASS_NEXT = {
        'PP1': 'PP2', 'PP2': 'Grade 1',
        'Grade 1': 'Grade 2', 'Grade 2': 'Grade 3', 'Grade 3': 'Grade 4',
        'Grade 4': 'Grade 5', 'Grade 5': 'Grade 6', 'Grade 6': 'Grade 7',
        'Grade 7': 'Grade 8', 'Grade 8': 'Grade 9', 'Grade 9': null
      };
      if (!(fromClass in CLASS_NEXT)) throw new Error('Invalid class');
      const next = CLASS_NEXT[fromClass];

      let result;
      if (next === null) {
        const { data, error } = await sb
          .from('learners')
          .update({ is_alumni: true })
          .eq('class', fromClass)
          .eq('is_alumni', false)
          .select('id');
        if (error) throw new Error(error.message);
        result = { count: (data || []).length, toClass: 'Alumni' };
      } else {
        const { data, error } = await sb
          .from('learners')
          .update({ class: next })
          .eq('class', fromClass)
          .eq('is_alumni', false)
          .select('id');
        if (error) throw new Error(error.message);
        result = { count: (data || []).length, toClass: next };
      }
      return {
        message: `Promoted ${result.count} learner(s) from ${fromClass} to ${result.toClass}`,
        count: result.count,
        fromClass,
        toClass: result.toClass
      };
    },

    // ----- GRADES -----
    async getGrades(params) {
      await requireSession();
      let q = sb.from('grades').select('id, learner_id, term, exam, year, eng, math, kisw, ss, cas, agri, ins, pre_tech, cre, total, mean, learners!inner(first_name, last_name, upi, class, is_alumni)');
      if (params.class) {
        q = q.eq('learners.class', params.class).or('is_alumni.eq.false,is_alumni.is.null', { foreignTable: 'learners' });
      }
      if (params.term) q = q.eq('term', params.term);
      if (params.exam) q = q.eq('exam', params.exam);
      if (params.year) q = q.eq('year', params.year);
      q = q.order('total', { ascending: false });

      const { data, error } = await q;
      if (error) throw new Error(error.message);

      // flatten join shape to match old API
      return (data || []).map((g) => {
        const l = g.learners || {};
        return {
          ...g,
          first_name: l.first_name,
          last_name: l.last_name,
          upi: l.upi,
          class: l.class,
          is_alumni: l.is_alumni,
          learners: undefined
        };
      });
    },

    async saveGrades({ learnerId, term, exam, year, scores, mergeOnly }) {
      const session = await requireSession();
      const cols = ['eng', 'math', 'kisw', 'ss', 'cas', 'agri', 'ins', 'pre_tech', 'cre'];

      // Map UI codes → DB columns; only columns present in `scores` are updated
      const byCol = {};
      for (const [code, raw] of Object.entries(scores || {})) {
        const col = CODE_TO_COL[code] || CODE_TO_COL[String(code).trim()];
        if (!col) continue;
        const n = Number(raw);
        if (Number.isNaN(n) || n < 0 || n > 100) throw new Error(`Score for ${code} must be 0–100`);
        byCol[col] = n;
      }
      if (!Object.keys(byCol).length) {
        throw new Error('No valid subject scores to save');
      }

      // Prefer atomic RPC (1 round-trip, concurrent-safe partial update).
      // Falls back to the old 3-step path if the migration has not been run yet.
      try {
        const { data, error } = await sb.rpc('save_grade_row', {
          p_learner_id: Number(learnerId),
          p_term: term,
          p_exam: exam,
          p_year: Number(year),
          p_scores: byCol,
          p_saved_by: session.user.id
        });
        if (error) throw error;
        return {
          message: (data && data.message) || 'Grades saved',
          total: data && data.total,
          mean: data && data.mean
        };
      } catch (rpcErr) {
        const msg = (rpcErr && (rpcErr.message || rpcErr.details || '')) || '';
        // Only fall back when the function is missing; rethrow real validation errors
        if (!/function|does not exist|schema cache|PGRST202|42883/i.test(msg)) {
          throw new Error(msg || 'Could not save grades');
        }
      }

      // ----- Fallback (pre-migration): read → merge → write -----
      let merged = Object.fromEntries(cols.map((c) => [c, 0]));
      const { data: existing } = await sb.from('grades')
        .select('*')
        .eq('learner_id', learnerId)
        .eq('term', term)
        .eq('exam', exam)
        .eq('year', Number(year))
        .maybeSingle();
      if (existing) {
        cols.forEach((c) => {
          if (existing[c] != null) merged[c] = Number(existing[c]) || 0;
        });
      }
      Object.assign(merged, byCol);

      const { data: lr } = await sb.from('learners').select('class').eq('id', learnerId).maybeSingle();
      const meanCols = lr ? levelSubjects(lr.class) : cols;
      const levelTotal = meanCols.reduce((s, c) => s + (merged[c] || 0), 0);
      const mean = meanCols.length ? Math.round(levelTotal / meanCols.length) : 0;

      const row = {
        learner_id: learnerId,
        term,
        exam,
        year: Number(year),
        ...merged,
        total: levelTotal,
        mean,
        saved_by: session.user.id
      };

      const { error } = await sb.from('grades').upsert(row, {
        onConflict: 'learner_id,term,exam,year'
      });
      if (error) throw new Error(error.message);
      return { message: 'Grades saved', total: levelTotal, mean };
    },

    /**
     * Bulk grade save — one HTTP request for many learners (class grade entry).
     * Processes in small parallel chunks server-side to limit load.
     * body: { term, exam, year, entries: [{ learnerId, scores }] }
     */
    async saveGradesBulk({ term, exam, year, entries }) {
      await requireSession();
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) throw new Error('No scores to save');
      if (list.length > 200) throw new Error('Too many learners in one save (max 200)');

      const results = [];
      const CHUNK = 8;
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        const part = await Promise.all(
          slice.map(async (entry) => {
            try {
              const r = await api.saveGrades({
                learnerId: entry.learnerId,
                term,
                exam,
                year,
                scores: entry.scores || {}
              });
              return { learnerId: entry.learnerId, ok: true, total: r.total, mean: r.mean };
            } catch (e) {
              return {
                learnerId: entry.learnerId,
                ok: false,
                error: (e && e.message) || 'Save failed'
              };
            }
          })
        );
        results.push.apply(results, part);
      }
      const saved = results.filter((r) => r.ok).length;
      const failed = results.length - saved;
      return {
        message: failed
          ? `Saved ${saved}, ${failed} failed`
          : `Saved ${saved} learner(s)`,
        saved,
        failed,
        results
      };
    },

    // ----- TEACHERS -----
    async getTeachers() {
      await requireSession();
      const { data, error } = await sb.from('teachers').select('id, first_name, middle_name, surname, tsc_no, id_no, phone, email, tsc_email, gender, date_of_birth, date_joined, bank_acc_no, roles, is_class_teacher, assigned_class, education_level, teaching_level, subject_combination, learning_areas, work_load').order('surname');
      if (error) throw new Error(error.message);
      return (data || []).map((r) => ({
        ...r,
        learningAreas: Array.isArray(r.learning_areas) ? r.learning_areas : [],
        isClassTeacher: !!r.is_class_teacher,
        assigned_class: r.assigned_class
      }));
    },

    async createTeacher(body) {
      await requireSession();
      const row = mapTeacherBody(body);
      // Normalise login identity
      row.email = String(row.email || '').trim().toLowerCase();
      row.tsc_no = String(row.tsc_no || '').trim();
      if (!row.email) throw new Error('Email is required for teacher login');
      if (!row.tsc_no) throw new Error('TSC No is required (used as login password)');
      if (!/^\d{6,7}$/.test(row.tsc_no)) {
        throw new Error('TSC No must be 6 or 7 digits (it is used as the login password)');
      }
      validateTeacherLearningAreas(row.learning_areas);
      const { data: exist } = await sb.from('teachers').select('id').eq('tsc_no', row.tsc_no).maybeSingle();
      if (exist) throw new Error('TSC No already registered');
      const { data: emailExist } = await sb.from('teachers').select('id').ilike('email', row.email).maybeSingle();
      if (emailExist) throw new Error('A teacher with this email is already registered');
      const { error } = await sb.from('teachers').insert(row);
      if (error) throw new Error(error.message);

      // Keep admin logged in: signUp would otherwise replace the session with the new teacher.
      const { data: before } = await sb.auth.getSession();
      const adminSession = before && before.session
        ? {
            access_token: before.session.access_token,
            refresh_token: before.session.refresh_token
          }
        : null;

      const fullName = [row.first_name, row.middle_name, row.surname].filter(Boolean).join(' ');
      // IMPORTANT: In Supabase → Authentication → Providers → Email, turn OFF "Confirm email"
      // otherwise teachers get "Email not confirmed" / "Invalid credentials" on login.
      const { data: authData, error: authErr } = await sb.auth.signUp({
        email: row.email,
        password: row.tsc_no,
        options: {
          data: { role: 'teacher', name: fullName, username: row.email },
          emailRedirectTo: undefined
        }
      });

      // Ensure profiles row has role=teacher (login uses this) while we may briefly be the new user
      if (authData && authData.user && authData.user.id) {
        try {
          await sb.from('profiles').upsert({
            id: authData.user.id,
            email: row.email,
            name: fullName,
            username: row.email,
            role: 'teacher'
          }, { onConflict: 'id' });
        } catch (profileErr) {
          console.warn('Could not upsert teacher profile role:', profileErr);
        }
      }

      // Restore administrator session so the admin is NOT logged out
      let restored = false;
      if (adminSession && adminSession.access_token && adminSession.refresh_token) {
        try {
          const { error: setErr } = await sb.auth.setSession({
            access_token: adminSession.access_token,
            refresh_token: adminSession.refresh_token
          });
          if (!setErr) restored = true;
        } catch (_) {}
      }
      if (!restored) {
        // Do not leave the browser on the new teacher's session
        try { await sb.auth.signOut(); } catch (e) {}
      }

      if (authErr) {
        const msg = authErr.message || 'Could not create login account';
        if (/already|registered|exists/i.test(msg)) {
          return {
            message: restored
              ? 'Teacher record saved, but this email already exists in Supabase Auth. Open Authentication → Users, select the user, confirm the email if needed, and set the password to the TSC No.'
              : 'Teacher record saved. Login email already registered in Auth. Sign in again as admin, then fix the Auth user password/confirm status.',
            needsReLogin: !restored
          };
        }
        if (/password|least|characters|weak/i.test(msg)) {
          return {
            message: restored
              ? 'Teacher saved but Auth rejected the password: ' + msg + ' (TSC No is used as password — must meet Supabase password rules).'
              : 'Teacher saved but login failed: ' + msg + '. Sign in again as admin.',
            needsReLogin: !restored
          };
        }
        return {
          message: restored
            ? 'Teacher saved but login account failed: ' + msg
            : 'Teacher saved but login failed: ' + msg + '. Sign in again as admin.',
          needsReLogin: !restored
        };
      }

      // Session present ⇒ Confirm email is OFF and account is ready immediately
      const readyNow = !!(authData && authData.session);
      const needsConfirm = authData && authData.user && !authData.session;
      return {
        message: readyNow
          ? (restored
            ? 'Teacher added. They can sign in now with their email + TSC No as password.'
            : 'Teacher added. Sign in again as admin. They use email + TSC No as password.')
          : (needsConfirm
            ? (restored
              ? 'Teacher added, but email confirmation is required. In Supabase: Authentication → Providers → Email → turn OFF “Confirm email”, OR Authentication → Users → confirm this teacher’s email. Then they sign in with email + TSC No.'
              : 'Teacher added (email confirmation pending). Confirm in Supabase Auth, then sign in again as admin.')
            : (restored
              ? 'Teacher added. They sign in with email + TSC No as password.'
              : 'Teacher added. Sign in again as admin. They use email + TSC No as password.')),
        needsReLogin: !restored,
        authReady: readyNow,
        needsEmailConfirm: !!needsConfirm
      };
    },

    async updateTeacher(id, body) {
      await requireSession();
      const row = mapTeacherBody(body);
      validateTeacherLearningAreas(row.learning_areas);
      const { data: exist } = await sb
        .from('teachers')
        .select('id')
        .eq('tsc_no', row.tsc_no)
        .neq('id', id)
        .maybeSingle();
      if (exist) throw new Error('TSC No already registered');
      const { error } = await sb.from('teachers').update(row).eq('id', id);
      if (error) throw new Error(error.message);
      return { message: 'Updated' };
    },

    // Teacher self-service: a teacher may update only their own contact details
    // (phone, TSC Gmail, bank account). Everything else stays admin-only via
    // updateTeacher() above. The row is matched by the signed-in user's own
    // auth email, never by an id supplied from the client, so a teacher can
    // only ever touch their own record.
    async updateOwnTeacherProfile(body) {
      const session = await requireSession();
      const email = String(session.user.email || '').trim().toLowerCase();
      const { data: mine, error: findErr } = await sb
        .from('teachers')
        .select('id')
        .ilike('email', email)
        .maybeSingle();
      if (findErr) throw new Error(findErr.message);
      if (!mine) throw new Error('No teacher record found for your account.');

      const phone = String(body.phone || '').replace(/\s/g, '');
      const tscEmail = String(body.tscEmail || '').trim().toLowerCase();
      const bankAccNo = body.bankAccNo ? String(body.bankAccNo).trim() : null;
      if (!/^\d{10}$/.test(phone)) throw new Error('Phone must be exactly 10 digits');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tscEmail)) throw new Error('Invalid TSC Gmail format');
      if (bankAccNo && !/^\d+$/.test(bankAccNo)) throw new Error('Bank account number must be digits only');

      const row = { phone, tsc_email: tscEmail, bank_acc_no: bankAccNo };
      const { error } = await sb.from('teachers').update(row).eq('id', mine.id);
      if (error) throw new Error(error.message);
      return { message: 'Profile updated' };
    },

    async deleteTeacher(id) {
      await requireSession();
      // Load teacher so we can clean related rows (Auth user needs service role — see note below)
      const { data: teacher, error: fetchErr } = await sb
        .from('teachers')
        .select('id, email')
        .eq('id', id)
        .maybeSingle();
      if (fetchErr) throw new Error(fetchErr.message);
      if (!teacher) throw new Error('Teacher not found');

      const email = String(teacher.email || '').trim().toLowerCase();

      const { error } = await sb.from('teachers').delete().eq('id', id);
      if (error) throw new Error(error.message);

      // Remove app profile row if present (same email / login identity)
      if (email) {
        try {
          await sb.from('profiles').delete().ilike('email', email);
        } catch (_) {}
      }

      // NOTE: auth.users cannot be deleted with the anon/publishable key.
      // That requires the service_role key (server/Edge Function only).
      // The Auth account may still appear under Authentication → Users until
      // an admin deletes it there. Until then, re-adding the same email will
      // report that the login email already exists in Auth.
      return {
        message: email
          ? 'Teacher removed from the app. If they still appear under Supabase → Authentication → Users, delete that Auth user there as well (or they can keep signing in with the old email + TSC No until removed).'
          : 'Teacher removed from the app.'
      };
    }
  };

  function validateTeacherLearningAreas(areas) {
    const list = Array.isArray(areas) ? areas : [];
    const complete = list.filter((a) => {
      const name = (a && (a.name || (typeof a === 'string' ? a : '')) || '').toString().trim();
      const cls = (a && a.class ? String(a.class) : '').trim();
      return name && cls;
    });
    if (!complete.length) {
      throw new Error('At least one learning area with both subject and class is required');
    }
    for (const a of list) {
      const name = (a && (a.name || (typeof a === 'string' ? a : '')) || '').toString().trim();
      const cls = (a && a.class ? String(a.class) : '').trim();
      if (name && !cls) throw new Error('Class is required for learning area "' + name + '"');
      if (cls && !name) throw new Error('Subject is required when a class is selected for a learning area');
    }
  }

  function mapTeacherBody(body) {
    return {
      first_name: body.firstName,
      middle_name: body.middleName || null,
      surname: body.surname,
      tsc_no: String(body.tscNo || '').trim(),
      id_no: String(body.idNo || '').trim(),
      phone: String(body.phone || '').replace(/\s/g, ''),
      email: String(body.email || '').trim().toLowerCase(),
      tsc_email: String(body.tscEmail || '').trim().toLowerCase(),
      gender: body.gender,
      date_of_birth: body.dateOfBirth || null,
      date_joined: body.dateJoined || null,
      bank_acc_no: body.bankAccNo ? String(body.bankAccNo).trim() : null,
      roles: body.roles || null,
      is_class_teacher: !!body.isClassTeacher,
      assigned_class: body.isClassTeacher ? (body.assignedClass || null) : null,
      education_level: body.educationLevel || null,
      teaching_level: body.teachingLevel || null,
      work_load: (body.workLoad !== undefined && body.workLoad !== null && String(body.workLoad).trim() !== '')
        ? parseInt(body.workLoad, 10) : null,
      subject_combination: body.subjectCombination ? String(body.subjectCombination).trim() : null,
      learning_areas: (body.learningAreas || []).map((a) =>
        typeof a === 'string'
          ? { name: a.trim(), class: null, code: null, col: null }
          : {
              name: String(a.name || '').trim(),
              class: a.class ? String(a.class).trim() : null,
              code: a.code || null,
              col: a.col || null
            }
      ).filter((a) => a.name && a.class)
    };
  }

  /**
   * Adapter that matches the old `api(url, opts)` signature used in index.html.
   * Call sites can keep working with minimal changes.
   */
  async function apiFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body;

    try {
      // Auth
      if (url === '/api/login' && method === 'POST') {
        return api.login(body.username, body.password);
      }
      if (url === '/api/logout' && method === 'POST') {
        return api.logout();
      }
      if (url === '/api/me') {
        return api.me();
      }
      if (url === '/api/verify-password' && method === 'POST') {
        return api.verifyPassword(body.password);
      }

      // Learners
      if (url === '/api/learners' && method === 'GET') {
        return api.getLearners();
      }
      if (url === '/api/learners' && method === 'POST') {
        return api.createLearner(body); // FormData
      }
      if (url.startsWith('/api/learners/') && method === 'PUT') {
        const id = url.split('/').pop();
        return api.updateLearner(id, body);
      }
      if (url.startsWith('/api/learners/') && method === 'DELETE') {
        const id = url.split('/').pop();
        return api.deleteLearner(id);
      }
      if (url === '/api/learners/promote' && method === 'POST') {
        return api.promoteLearners(body.fromClass, body.password, body.passwordConfirm);
      }

      // Grades
      if (url.startsWith('/api/grades') && method === 'GET') {
        const q = {};
        const u = new URL(url, 'http://local');
        u.searchParams.forEach((v, k) => { q[k === 'class' ? 'class' : k] = v; });
        // also support ?class=
        if (url.includes('class=')) {
          const m = url.match(/[?&]class=([^&]+)/);
          if (m) q.class = decodeURIComponent(m[1]);
        }
        if (url.includes('term=')) {
          const m = url.match(/[?&]term=([^&]+)/);
          if (m) q.term = decodeURIComponent(m[1]);
        }
        if (url.includes('exam=')) {
          const m = url.match(/[?&]exam=([^&]+)/);
          if (m) q.exam = decodeURIComponent(m[1]);
        }
        if (url.includes('year=')) {
          const m = url.match(/[?&]year=([^&]+)/);
          if (m) q.year = decodeURIComponent(m[1]);
        }
        return api.getGrades(q);
      }
      if (url === '/api/grades' && method === 'POST') {
        // Bulk: { term, exam, year, entries: [...] }
        if (body && Array.isArray(body.entries)) {
          return api.saveGradesBulk(body);
        }
        return api.saveGrades(body);
      }
      if (url === '/api/grades/bulk' && method === 'POST') {
        return api.saveGradesBulk(body);
      }

      // Teachers
      if (url === '/api/teachers' && method === 'GET') {
        return api.getTeachers();
      }
      if (url === '/api/teachers' && method === 'POST') {
        return api.createTeacher(body);
      }
      if (url === '/api/teachers/me' && method === 'PUT') {
        return api.updateOwnTeacherProfile(body);
      }
      if (url.startsWith('/api/teachers/') && method === 'PUT') {
        const id = url.split('/').pop();
        return api.updateTeacher(id, body);
      }
      if (url.startsWith('/api/teachers/') && method === 'DELETE') {
        const id = url.split('/').pop();
        return api.deleteTeacher(id);
      }

      throw new Error('Unknown API route: ' + url);
    } catch (e) {
      if (e.status === 401 || /session expired|not authenticated/i.test(e.message || '')) {
        try {
          sessionStorage.removeItem('kagumori_session');
          localStorage.removeItem('kagumori_session');
        } catch (_) {}
      }
      throw e;
    }
  }

  global.KagumoriAPI = api;
  global.api = apiFetch; // overrides the old fetch-based api() if loaded after
})(typeof window !== 'undefined' ? window : globalThis);
