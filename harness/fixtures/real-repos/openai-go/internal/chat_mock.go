package internal

const documentedCall = `client.Chat.Completions.New(ctx, params)`

// client.Chat.Completions.New(ctx, params) is intentionally only a comment.
type ChatMock struct {
	Reply string
}

func (mock ChatMock) Complete() string {
	return mock.Reply
}
