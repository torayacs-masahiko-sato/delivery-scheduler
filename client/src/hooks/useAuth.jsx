import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('ds_user')); } catch { return null; }
  });

  const login = (userData) => {
    setUser(userData);
    sessionStorage.setItem('ds_user', JSON.stringify(userData));
  };

  // 画面内の表示情報だけ更新（例: 多要素認証の有効/無効）
  const updateUser = (patch) => {
    setUser(prev => {
      const next = { ...prev, ...patch };
      sessionStorage.setItem('ds_user', JSON.stringify(next));
      return next;
    });
  };

  const logout = () => {
    setUser(null);
    sessionStorage.removeItem('ds_user');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
