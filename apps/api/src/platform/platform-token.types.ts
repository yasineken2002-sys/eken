export interface PlatformJwtPayload {
  sub: string
  email: string
  type: 'platform'
  iat?: number
  exp?: number
}

export interface PlatformTokenPair {
  accessToken: string
  refreshToken: string
}
