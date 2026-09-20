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

  const sb = global.supabase.createClient(
    global.SUPABASE_URL,
    global.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: global.sessionStorage // tab-close ends session (matches original behaviour)
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

  // ---------- public API (mirrors old fetch /api/*) ----------
  const api = {
    /** Low-level access if needed */
    client: sb,

    async login(usernameOrEmail, password) {
      // Admin: email + password. Teacher: email + TSC No as password.
      let email = String(usernameOrEmail || '').trim();
      if (!email) throw new Error('Email is required');
      if (!email.includes('@')) {
        throw new Error('Enter your full email address');
      }
      const { data, error } = await sb.auth.signInWithPassword({ email, password: String(password || '') });
      if (error) throw new Error(error.message || 'Invalid credentials');

      const user = data.user;
      let profile = { name: user.email, role: 'admin' };
      const { data: rows } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (rows) profile = { ...profile, ...rows };
      // Teacher metadata fallback
      const metaRole = user.user_metadata && user.user_metadata.role;
      const role = profile.role || metaRole || 'admin';
      const name = profile.name || (user.user_metadata && user.user_metadata.name) || (role === 'teacher' ? 'Teacher' : 'Administrator');

      return {
        user: {
          id: user.id,
          username: profile.username || user.email,
          name,
          role,
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
      const { data: rows } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      const metaRole = user.user_metadata && user.user_metadata.role;
      const role = (rows && rows.role) || metaRole || 'admin';
      return {
        user: {
          id: user.id,
          username: (rows && rows.username) || user.email,
          name: (rows && rows.name) || (user.user_metadata && user.user_metadata.name) || (role === 'teacher' ? 'Teacher' : 'Administrator'),
          role,
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
      const { data, error } = await sb
        .from('learners')
        .select('*')
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
      await requireSession();
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
      await requireSession();
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
      await requireSession();
      const { data: row } = await sb.from('learners').select('profile_picture, document_path').eq('id', id).maybeSingle();
      if (row) {
        await removeStoragePath('learner-profiles', row.profile_picture);
        await removeStoragePath('learner-documents', row.document_path);
      }
      const { error } = await sb.from('learners').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { message: 'Deleted' };
    },

    async promoteLearners(fromClass, password, passwordConfirm) {
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
      let q = sb.from('grades').select('*, learners!inner(first_name, last_name, upi, class, is_alumni)');
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
      await requireSession();
      const session = await requireSession();
      const cols = ['eng', 'math', 'kisw', 'ss', 'cas', 'agri', 'ins', 'pre_tech', 'cre'];

      // Start from existing row so teachers only overwrite their subject(s)
      let byCol = Object.fromEntries(cols.map((c) => [c, 0]));
      const { data: existing } = await sb.from('grades')
        .select('*')
        .eq('learner_id', learnerId)
        .eq('term', term)
        .eq('exam', exam)
        .eq('year', Number(year))
        .maybeSingle();
      if (existing) {
        cols.forEach((c) => {
          if (existing[c] != null) byCol[c] = Number(existing[c]) || 0;
        });
      }

      for (const [code, raw] of Object.entries(scores || {})) {
        const col = CODE_TO_COL[code] || CODE_TO_COL[String(code).trim()];
        if (!col) continue;
        const n = Number(raw);
        if (Number.isNaN(n) || n < 0 || n > 100) throw new Error(`Score for ${code} must be 0–100`);
        byCol[col] = n;
      }

      const { data: lr } = await sb.from('learners').select('class').eq('id', learnerId).maybeSingle();
      const meanCols = lr ? levelSubjects(lr.class) : cols;
      const levelTotal = meanCols.reduce((s, c) => s + (byCol[c] || 0), 0);
      const mean = meanCols.length ? Math.round(levelTotal / meanCols.length) : 0;

      const row = {
        learner_id: learnerId,
        term,
        exam,
        year: Number(year),
        ...byCol,
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

    // ----- TEACHERS -----
    async getTeachers() {
      await requireSession();
      const { data, error } = await sb.from('teachers').select('*').order('surname');
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
      if (!row.email) throw new Error('Email is required for teacher login');
      if (!row.tsc_no) throw new Error('TSC No is required (used as login password)');
      const { data: exist } = await sb.from('teachers').select('id').eq('tsc_no', row.tsc_no).maybeSingle();
      if (exist) throw new Error('TSC No already registered');
      const { error } = await sb.from('teachers').insert(row);
      if (error) throw new Error(error.message);

      // Create Auth user: email + password = TSC No (teacher login)
      const fullName = [row.first_name, row.middle_name, row.surname].filter(Boolean).join(' ');
      // Create Auth user: email + password = TSC No from registration
      // IMPORTANT: In Supabase → Authentication → Providers → Email, turn OFF "Confirm email"
      // otherwise teachers get "Email not confirmed" on login.
      const { data: authData, error: authErr } = await sb.auth.signUp({
        email: row.email,
        password: String(row.tsc_no),
        options: {
          data: { role: 'teacher', name: fullName, username: row.email },
          emailRedirectTo: undefined
        }
      });
      // signUp may switch session to the new teacher — sign out so admin re-logins
      try { await sb.auth.signOut(); } catch (e) {}
      if (authErr) {
        const msg = authErr.message || 'Could not create login account';
        if (/already|registered|exists/i.test(msg)) {
          return {
            message: 'Teacher record saved. Login email already registered — confirm the user in Supabase Auth (Users) if needed. Sign in again as admin.',
            needsReLogin: true
          };
        }
        return {
          message: 'Teacher saved but login failed: ' + msg + '. Sign in again as admin.',
          needsReLogin: true
        };
      }
      // If project requires email confirm, user will not be able to sign in until confirmed
      const needsConfirm = authData && authData.user && !authData.session;
      return {
        message: needsConfirm
          ? 'Teacher added. Confirm their email in Supabase Auth → Users (or disable Confirm email), then they can sign in with email + TSC No. Sign in again as admin.'
          : 'Teacher added. They sign in with email + TSC No as password. Sign in again as admin.',
        needsReLogin: true
      };
    },

    async updateTeacher(id, body) {
      await requireSession();
      const row = mapTeacherBody(body);
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

    async deleteTeacher(id) {
      await requireSession();
      const { error } = await sb.from('teachers').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { message: 'Deleted' };
    }
  };

  function mapTeacherBody(body) {
    return {
      first_name: body.firstName,
      middle_name: body.middleName || null,
      surname: body.surname,
      tsc_no: String(body.tscNo || '').trim(),
      id_no: String(body.idNo || '').trim(),
      phone: String(body.phone || '').replace(/\s/g, ''),
      email: String(body.email || '').trim(),
      tsc_email: String(body.tscEmail || '').trim(),
      gender: body.gender,
      date_of_birth: body.dateOfBirth || null,
      date_joined: body.dateJoined || null,
      bank_acc_no: body.bankAccNo ? String(body.bankAccNo).trim() : null,
      roles: body.roles || null,
      is_class_teacher: !!body.isClassTeacher,
      assigned_class: body.isClassTeacher ? (body.assignedClass || null) : null,
      education_level: body.educationLevel || null,
      teaching_level: body.teachingLevel || null,
      subject_combination: body.subjectCombination ? String(body.subjectCombination).trim() : null,
      learning_areas: (body.learningAreas || []).map((a) =>
        typeof a === 'string'
          ? { name: a.trim(), class: null, code: null, col: null }
          : {
              name: String(a.name || '').trim(),
              class: a.class || null,
              code: a.code || null,
              col: a.col || null
            }
      )
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
        return api.saveGrades(body);
      }

      // Teachers
      if (url === '/api/teachers' && method === 'GET') {
        return api.getTeachers();
      }
      if (url === '/api/teachers' && method === 'POST') {
        return api.createTeacher(body);
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
        try { sessionStorage.removeItem('kagumori_session'); } catch (_) {}
      }
      throw e;
    }
  }

  global.KagumoriAPI = api;
  global.api = apiFetch; // overrides the old fetch-based api() if loaded after
})(typeof window !== 'undefined' ? window : globalThis);
