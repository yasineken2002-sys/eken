/**
 * PSD2-callbacken: @Public, men auktorisering bärs av single-use `state` i
 * consent-servicen. Controllern ska ALLTID 302-redirecta tillbaka till frontend
 * (ok vid lyckat samtycke, felflagga annars) — aldrig läcka en känslig detalj i
 * svaret, aldrig kasta ett rått fel mot bankens webbläsar-redirect.
 */

import { Psd2Controller } from './psd2.controller'

function makeReply() {
  const reply = { status: jest.fn(), header: jest.fn(), send: jest.fn() }
  reply.status.mockReturnValue(reply)
  reply.header.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

function makeController(handleCallback: jest.Mock) {
  const consent = {
    handleCallback,
    appReturnUrl: (ok: boolean) => `https://app/return?psd2=${ok ? 'ok' : 'error'}`,
  }
  const syncQueue = { enqueueOrgSync: jest.fn() }
  return new Psd2Controller(consent as never, syncQueue as never)
}

describe('Psd2Controller.callback', () => {
  it('lyckat samtycke → 302 redirect med ok-flagga', async () => {
    const handleCallback = jest.fn().mockResolvedValue({ organizationId: 'org-1' })
    const controller = makeController(handleCallback)
    const reply = makeReply()

    await controller.callback(reply as never, 'state-1', 'code-1')

    expect(handleCallback).toHaveBeenCalledWith('state-1', 'code-1')
    expect(reply.status).toHaveBeenCalledWith(302)
    expect(reply.header).toHaveBeenCalledWith('location', 'https://app/return?psd2=ok')
  })

  it('ogiltig/förbrukad state → 302 redirect med felflagga, inget kastat fel', async () => {
    const handleCallback = jest.fn().mockRejectedValue(new Error('Ogiltig state'))
    const controller = makeController(handleCallback)
    const reply = makeReply()

    await expect(controller.callback(reply as never, 'fejk', 'x')).resolves.toBeUndefined()
    expect(reply.status).toHaveBeenCalledWith(302)
    expect(reply.header).toHaveBeenCalledWith('location', 'https://app/return?psd2=error')
  })

  it('saknade query-parametrar → felflagga (handleCallback får tomma strängar)', async () => {
    const handleCallback = jest.fn().mockRejectedValue(new Error('Saknar state eller code'))
    const controller = makeController(handleCallback)
    const reply = makeReply()

    await controller.callback(reply as never)

    expect(handleCallback).toHaveBeenCalledWith('', '')
    expect(reply.header).toHaveBeenCalledWith('location', 'https://app/return?psd2=error')
  })
})
